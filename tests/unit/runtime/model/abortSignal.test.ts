import { describe, it, expect } from 'vitest'
import { OpenAICompatibleModelClient } from '../../../../src/runtime/model/OpenAICompatibleModelClient'
import type { ChatEvent } from '../../../../src/runtime/model/types'

/**
 * 测试 ModelClient 的 AbortSignal 支持
 *
 * 核心验证点：
 * 1. AbortSignal 触发时，模型请求被中断
 * 2. 取消不会被伪装成普通 API 错误
 * 3. 已读取的部分内容不丢失
 */

/** 创建一个 SSE 响应流，支持通过 AbortSignal 中断 */
function createSSEStream(events: string[], delayMs = 50): ReadableStream<Uint8Array> {
  return new ReadableStream({
    async start(controller) {
      for (const event of events) {
        controller.enqueue(new TextEncoder().encode(`data: ${event}\n\n`))
        await new Promise(r => setTimeout(r, delayMs))
      }
      controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'))
      controller.close()
    }
  })
}

/** 构造一个 text_delta chunk */
function textDelta(content: string): string {
  return JSON.stringify({
    choices: [{ delta: { content }, finish_reason: null }]
  })
}

/** 构造一个 message_end chunk */
function messageEnd(): string {
  return JSON.stringify({
    choices: [{ delta: {}, finish_reason: 'stop' }]
  })
}

describe('OpenAICompatibleModelClient abort 支持', () => {
  const config = {
    baseUrl: 'http://localhost:12345/v1',
    apiKey: 'test-key',
    modelId: 'test-model'
  }

  it('chat 接口接受 options.abortSignal 参数', async () => {
    const client = new OpenAICompatibleModelClient(config)
    const controller = new AbortController()

    // 快速创建一个 mock fetch
    const originalFetch = globalThis.fetch
    let fetchCalled = false
    globalThis.fetch = async (_url: string, init?: RequestInit) => {
      fetchCalled = true
      // 验证 signal 被传入
      expect(init?.signal).toBe(controller.signal)

      return new Response(
        createSSEStream([textDelta('hi'), messageEnd()]),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
      )
    }

    const events: ChatEvent[] = []
    for await (const event of client.chat(
      [{ role: 'user', content: 'hello' }],
      undefined,
      { abortSignal: controller.signal }
    )) {
      events.push(event)
    }

    expect(fetchCalled).toBe(true)
    globalThis.fetch = originalFetch
  })

  it('取消请求时产出 cancelled 事件且不伪装为 API 错误', async () => {
    const client = new OpenAICompatibleModelClient(config)
    const controller = new AbortController()

    const originalFetch = globalThis.fetch
    globalThis.fetch = async (_url: string, init?: RequestInit) => {
      // 模拟 SSE 流，延迟较长以便取消
      const stream = new ReadableStream({
        async start(controller) {
          controller.enqueue(new TextEncoder().encode(`data: ${textDelta('开始...')}\n\n`))
          // 等足够久让 abort 有机会触发
          await new Promise(r => setTimeout(r, 500))
          controller.enqueue(new TextEncoder().encode(`data: ${textDelta('不应该到达')}\n\n`))
          controller.close()
        }
      })

      // 如果有 signal，监听 abort 事件来取消流
      if (init?.signal) {
        init.signal.addEventListener('abort', () => {
          // 模拟 fetch 的 AbortError
        })
      }

      return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    }

    const events: ChatEvent[] = []
    const iter = client.chat(
      [{ role: 'user', content: 'test' }],
      undefined,
      { abortSignal: controller.signal }
    )

    // 先读一个事件
    const firstResult = await iter.next()
    if (!firstResult.done) events.push(firstResult.value)

    // 取消
    setTimeout(() => controller.abort(), 100)

    // 继续消费
    for await (const event of iter) {
      events.push(event)
    }

    // 应该有 cancelled 事件（不是 error）
    const cancelledEvents = events.filter(e => e.type === 'cancelled')
    expect(cancelledEvents.length).toBeGreaterThanOrEqual(1)

    // 不应出现包含 "API 错误" 的 error 事件
    const errorEvents = events.filter(e => e.type === 'error')
    for (const err of errorEvents) {
      expect((err as { error: string }).error).not.toContain('API 错误')
    }

    globalThis.fetch = originalFetch
  })

  it('不传 abortSignal 时正常工作', async () => {
    const client = new OpenAICompatibleModelClient(config)

    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => {
      return new Response(
        createSSEStream([textDelta('正常响应'), messageEnd()]),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
      )
    }

    const events: ChatEvent[] = []
    for await (const event of client.chat([{ role: 'user', content: 'hello' }])) {
      events.push(event)
    }

    expect(events.some(e => e.type === 'text_delta')).toBe(true)
    expect(events.some(e => e.type === 'message_end')).toBe(true)

    globalThis.fetch = originalFetch
  })

  it('fetch 网络错误时仍然正常返回 error 事件', async () => {
    const client = new OpenAICompatibleModelClient(config)

    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => {
      throw new Error('网络连接失败')
    }

    const events: ChatEvent[] = []
    for await (const event of client.chat([{ role: 'user', content: 'hello' }])) {
      events.push(event)
    }

    // T2-5：最终 body 指纹在 error 之前上报
    expect(events.some(e => e.type === 'request_fingerprint')).toBe(true)
    const errorEvents = events.filter(e => e.type === 'error')
    expect(errorEvents).toHaveLength(1)
    // ModelTransport 规范化为分类错误前缀（network_reset / timeout_* 等）
    expect((errorEvents[0] as { error: string }).error).toMatch(/network_reset|请求失败|网络/)

    globalThis.fetch = originalFetch
  })
})
