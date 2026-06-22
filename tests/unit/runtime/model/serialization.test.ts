import { describe, it, expect, afterEach } from 'vitest'
import { OpenAICompatibleModelClient } from '../../../../src/runtime/model/OpenAICompatibleModelClient'
import type { ChatEvent } from '../../../../src/runtime/model/types'

/**
 * 验证序列化层对消息的处理：session context 必须进 API，internal 消息必须被过滤。
 *
 * v2 修正背景：
 * 上一版错误地用 internal:true 标记 session context，导致它被 OpenAICompatibleModelClient
 * 的 filter(m => !m.internal) 整条移除，模型永远看不到。审查 P0 指出这个致命缺陷。
 *
 * v2 合并方案：session context 拼到真实 user 消息的 content 前缀（不标 internal），
 * 它作为普通 user 消息的一部分正常进入 API。同时 internal 语义保持不变——仍用于
 * 压缩指令等"整条不进 API"的消息。
 *
 * 本测试用真实的 OpenAICompatibleModelClient（非 Mock），拦截 fetch 请求体，
 * 验证序列化后的消息字节流。
 */

function createSSEStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(
          `data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\n`
        )
      )
      controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'))
      controller.close()
    }
  })
}

describe('序列化层：session context 与 internal 消息', () => {
  const config = {
    baseUrl: 'http://localhost:12345/v1',
    apiKey: 'test-key',
    modelId: 'test-model'
  }

  let originalFetch: typeof globalThis.fetch
  let capturedBody: { messages: Array<Record<string, unknown>> } | null = null

  afterEach(() => {
    globalThis.fetch = originalFetch
    capturedBody = null
  })

  function installFetchCapture() {
    originalFetch = globalThis.fetch
    globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
      const bodyStr = init?.body as string
      capturedBody = JSON.parse(bodyStr)
      return new Response(createSSEStream(), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' }
      })
    }
  }

  async function drain(
    client: OpenAICompatibleModelClient,
    messages: Parameters<typeof client.chat>[0],
    options?: Parameters<typeof client.chat>[2]
  ) {
    const events: ChatEvent[] = []
    for await (const event of client.chat(messages, undefined, options)) {
      events.push(event)
    }
    return events
  }

  describe('session context（合并方案）：必须出现在 API 请求体中', () => {
    it('session context 拼在 user 消息 content 前缀时，正常进入 API', async () => {
      const client = new OpenAICompatibleModelClient(config)
      installFetchCapture()

      // 模拟 AgentLoop 合并方案构造的 user 消息：
      // content = "[Session context: ...]\n\n用户真实输入"
      const sessionContextText =
        '[Session context: Today is 2026-06-15, Monday. Current model: test-model. OS: Windows. Working directory: D:\\proj\\nova]'
      await drain(client, [
        { role: 'user', content: `${sessionContextText}\n\n帮我看看 src 目录` }
      ])

      expect(capturedBody).not.toBeNull()
      const sentMessages = capturedBody!.messages
      expect(sentMessages).toHaveLength(1)
      // session context 在 API 请求体中可见
      expect(sentMessages[0].content).toContain('[Session context:')
      expect(sentMessages[0].content).toContain('Working directory: D:\\proj\\nova')
      expect(sentMessages[0].content).toContain('帮我看看 src 目录')
    })

    it('session context 消息不携带任何额外字段（role + content only）', async () => {
      const client = new OpenAICompatibleModelClient(config)
      installFetchCapture()

      await drain(client, [
        { role: 'user', content: '[Session context: ...]\n\nhello' }
      ])

      const sent = capturedBody!.messages[0]
      // 白名单构造：只有 role + content
      expect(Object.keys(sent).sort()).toEqual(['content', 'role'])
    })
  })

  describe('internal 消息（压缩指令等）：默认过滤，受控调用可放行正文', () => {
    it('internal:true 的消息整条被过滤，不出现在 API 请求体中', async () => {
      const client = new OpenAICompatibleModelClient(config)
      installFetchCapture()

      await drain(client, [
        { role: 'user', content: '真实问题' },
        { role: 'user', content: '压缩指令', internal: true },
        { role: 'assistant', content: '压缩摘要', internal: true }
      ])

      expect(capturedBody).not.toBeNull()
      const sentMessages = capturedBody!.messages
      // 只有第一条真实问题保留，internal 消息被整条移除
      expect(sentMessages).toHaveLength(1)
      expect(sentMessages[0].content).toBe('真实问题')
      expect(sentMessages.every(m => !('internal' in m))).toBe(true)
    })

    it('internal:false 的消息正常发送（不过滤），但 internal 字段不进 API', async () => {
      const client = new OpenAICompatibleModelClient(config)
      installFetchCapture()

      await drain(client, [
        { role: 'user', content: 'q1' },
        { role: 'user', content: 'q2', internal: false }
      ])

      expect(capturedBody!.messages).toHaveLength(2)
      // internal:false 不作为字段出现在 API 字节流（白名单不包含它）
      expect('internal' in capturedBody!.messages[1]).toBe(false)
    })

    it('受控内部调用可放行 internal 正文，但 internal 字段仍不会进入 API', async () => {
      const client = new OpenAICompatibleModelClient(config)
      installFetchCapture()

      await drain(client, [
        { role: 'user', content: '真实问题' },
        { role: 'user', content: '请对上面的对话历史生成摘要', internal: true }
      ], {
        includeInternalMessages: true
      })

      expect(capturedBody!.messages).toHaveLength(2)
      expect(capturedBody!.messages[1].content).toBe('请对上面的对话历史生成摘要')
      expect('internal' in capturedBody!.messages[1]).toBe(false)
    })

    it('未配对的 assistant.tool_calls 经 sanitize 后剥离，API 只保留正文', async () => {
      const client = new OpenAICompatibleModelClient(config)
      installFetchCapture()

      // 典型场景：工具批次 abort 残留——assistant 声明了 tool_calls 但无对应 tool 响应。
      // sanitizeToolMessages 会剥离未配对项，避免 DeepSeek 等严格后端 400。
      await drain(client, [
        {
          role: 'assistant',
          content: '带工具调用',
          toolCalls: [{ id: 'tc1', name: 'ls', arguments: '{}' }]
        }
      ])

      const sent = capturedBody!.messages[0]
      expect(sent.role).toBe('assistant')
      expect(sent.content).toBe('带工具调用')
      expect(sent.tool_calls).toBeUndefined()
      expect(Object.keys(sent).sort()).toEqual(['content', 'role'])
    })

    it('配对的 assistant.tool_calls + tool 响应经序列化后保留 tool_calls', async () => {
      const client = new OpenAICompatibleModelClient(config)
      installFetchCapture()

      await drain(client, [
        {
          role: 'assistant',
          content: '带工具调用',
          toolCalls: [{ id: 'tc1', name: 'ls', arguments: '{}' }]
        },
        { role: 'tool', content: 'file1.ts', toolCallId: 'tc1' }
      ])

      const sent = capturedBody!.messages[0]
      expect(sent.role).toBe('assistant')
      expect(sent.content).toBe('带工具调用')
      expect(sent.tool_calls).toEqual([
        { id: 'tc1', type: 'function', function: { name: 'ls', arguments: '{}' } }
      ])
      expect(Object.keys(sent).sort()).toEqual(['content', 'role', 'tool_calls'])
      // 配对的 tool 消息也应出现在 API 请求体中
      expect(capturedBody!.messages[1]).toMatchObject({
        role: 'tool',
        content: 'file1.ts',
        tool_call_id: 'tc1'
      })
    })

    it('混合场景：session context（真实消息）保留 + internal 压缩指令被剥离', async () => {
      const client = new OpenAICompatibleModelClient(config)
      installFetchCapture()

      await drain(client, [
        { role: 'user', content: '[Session context: ...]\n\nq1' }, // session context，保留
        { role: 'assistant', content: 'a1' },
        { role: 'user', content: '压缩指令', internal: true }, // 剥
        { role: 'user', content: '[Session context: ...]\n\nq2' } // session context，保留
      ])

      expect(capturedBody!.messages).toHaveLength(3)
      expect(capturedBody!.messages.map(m => m.content)).toEqual([
        '[Session context: ...]\n\nq1',
        'a1',
        '[Session context: ...]\n\nq2'
      ])
    })
  })
})
