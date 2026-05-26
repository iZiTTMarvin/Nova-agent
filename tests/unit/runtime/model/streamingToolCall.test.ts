import { describe, it, expect, afterEach } from 'vitest'
import { OpenAICompatibleModelClient } from '../../../../src/runtime/model/OpenAICompatibleModelClient'
import type { ChatEvent } from '../../../../src/runtime/model/types'

/**
 * 测试 SSE 流式工具调用的增量 yield 行为
 *
 * 核心验证点：
 * 1. 收到第一个含 id 的 chunk 时立刻 yield tool_call_start
 * 2. 后续 arguments 片段 yield tool_call_delta
 * 3. 流结束后仍 yield 完整 tool_call（参数齐全可执行的信号）
 * 4. 事件顺序严格为 tool_call_start → tool_call_delta×N → tool_call
 */

/** 创建 SSE 响应流 */
function createSSEStream(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(new TextEncoder().encode(`data: ${chunk}\n\n`))
      }
      controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'))
      controller.close()
    }
  })
}

/** 构造 text_delta chunk */
function textDelta(content: string): string {
  return JSON.stringify({
    choices: [{ delta: { content }, finish_reason: null }]
  })
}

/** 构造 tool_call_start chunk（第一个 chunk，含 id + name + 可选初始 arguments） */
function toolCallStart(index: number, id: string, name: string, args?: string): string {
  const delta: Record<string, unknown> = {
    tool_calls: [{
      index,
      id,
      function: { name }
    }]
  }
  if (args !== undefined) {
    ;(delta.tool_calls as Record<string, unknown>[])[0] = {
      index,
      id,
      function: { name, arguments: args }
    }
  }
  return JSON.stringify({ choices: [{ delta, finish_reason: null }] })
}

/** 构造 tool_call_delta chunk（后续 chunk，只含 arguments 增量） */
function toolCallDelta(index: number, args: string): string {
  return JSON.stringify({
    choices: [{
      delta: {
        tool_calls: [{ index, function: { arguments: args } }]
      },
      finish_reason: null
    }]
  })
}

/** 构造 message_end chunk */
function messageEnd(reason = 'tool_calls'): string {
  return JSON.stringify({
    choices: [{ delta: {}, finish_reason: reason }]
  })
}

describe('OpenAICompatibleModelClient 流式工具调用增量 yield', () => {
  const config = {
    baseUrl: 'http://localhost:12345/v1',
    apiKey: 'test-key',
    modelId: 'test-model'
  }

  let originalFetch: typeof globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('单工具调用：完整 start → delta → tool_call 序列', async () => {
    const client = new OpenAICompatibleModelClient(config)
    originalFetch = globalThis.fetch

    globalThis.fetch = async () => {
      return new Response(
        createSSEStream([
          textDelta('我来写文件'),
          toolCallStart(0, 'call_1', 'write', '{"path":"index.html","content":"'),
          toolCallDelta(0, '<!DOCTYPE html>\\n'),
          toolCallDelta(0, '<html>'),
          messageEnd()
        ]),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
      )
    }

    const events: ChatEvent[] = []
    for await (const event of client.chat([{ role: 'user', content: 'write a file' }])) {
      events.push(event)
    }

    // 提取工具调用相关事件
    const toolEvents = events.filter(e =>
      e.type === 'tool_call_start' || e.type === 'tool_call_delta' || e.type === 'tool_call'
    )

    // 第一个必须是 tool_call_start
    expect(toolEvents[0].type).toBe('tool_call_start')
    if (toolEvents[0].type === 'tool_call_start') {
      expect(toolEvents[0].toolCallId).toBe('call_1')
      expect(toolEvents[0].toolName).toBe('write')
      expect(toolEvents[0].index).toBe(0)
    }

    // 中间若干 tool_call_delta
    const deltas = toolEvents.filter(e => e.type === 'tool_call_delta')
    expect(deltas.length).toBe(3) // 1 初始 + 2 后续
    if (deltas[0].type === 'tool_call_delta') {
      expect(deltas[0].toolCallId).toBe('call_1')
      expect(deltas[0].argumentsDelta).toBe('{"path":"index.html","content":"')
    }

    // 最后一个是 tool_call
    expect(toolEvents[toolEvents.length - 1].type).toBe('tool_call')
    if (toolEvents[toolEvents.length - 1].type === 'tool_call') {
      const tc = toolEvents[toolEvents.length - 1].toolCall
      expect(tc.id).toBe('call_1')
      expect(tc.name).toBe('write')
      // 完整参数 = 初始 + 2 个增量的拼接
      expect(tc.arguments).toBe('{"path":"index.html","content":"<!DOCTYPE html>\\n<html>')
    }
  })

  it('第一个 chunk 不带初始 arguments 时仍正确 yield start', async () => {
    const client = new OpenAICompatibleModelClient(config)
    originalFetch = globalThis.fetch

    globalThis.fetch = async () => {
      return new Response(
        createSSEStream([
          toolCallStart(0, 'call_2', 'bash'), // 无初始 arguments
          toolCallDelta(0, '{"command":"ls"}'),
          messageEnd()
        ]),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
      )
    }

    const events: ChatEvent[] = []
    for await (const event of client.chat([{ role: 'user', content: 'run ls' }])) {
      events.push(event)
    }

    const toolEvents = events.filter(e =>
      e.type === 'tool_call_start' || e.type === 'tool_call_delta' || e.type === 'tool_call'
    )

    // start 在最前面
    expect(toolEvents[0].type).toBe('tool_call_start')
    if (toolEvents[0].type === 'tool_call_start') {
      expect(toolEvents[0].toolCallId).toBe('call_2')
      expect(toolEvents[0].toolName).toBe('bash')
    }

    // 只有一个 delta（start 时无初始 arguments）
    const deltas = toolEvents.filter(e => e.type === 'tool_call_delta')
    expect(deltas.length).toBe(1)
    if (deltas[0].type === 'tool_call_delta') {
      expect(deltas[0].argumentsDelta).toBe('{"command":"ls"}')
    }

    // 最后是完整 tool_call
    expect(toolEvents[toolEvents.length - 1].type).toBe('tool_call')
  })

  it('多工具并发调用：每条调用独立产出 start/delta 序列', async () => {
    const client = new OpenAICompatibleModelClient(config)
    originalFetch = globalThis.fetch

    globalThis.fetch = async () => {
      return new Response(
        createSSEStream([
          toolCallStart(0, 'call_a', 'write', '{"path":"a.ts","content":"'),
          toolCallStart(1, 'call_b', 'edit', '{"path":"b.ts","old":"'),
          toolCallDelta(0, 'const a = 1"'),
          toolCallDelta(1, 'old_val","new":"new_val"}'),
          messageEnd()
        ]),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
      )
    }

    const events: ChatEvent[] = []
    for await (const event of client.chat([{ role: 'user', content: 'do both' }])) {
      events.push(event)
    }

    // 两个 tool_call_start
    const starts = events.filter(e => e.type === 'tool_call_start')
    expect(starts.length).toBe(2)
    const startIds = starts.map(e => (e as { toolCallId: string }).toolCallId)
    expect(startIds).toContain('call_a')
    expect(startIds).toContain('call_b')

    // 两个完整 tool_call
    const finalCalls = events.filter(e => e.type === 'tool_call')
    expect(finalCalls.length).toBe(2)
  })

  it('cancel 路径：不会 yield 末尾的完整 tool_call', async () => {
    const client = new OpenAICompatibleModelClient(config)
    const controller = new AbortController()
    originalFetch = globalThis.fetch

    globalThis.fetch = async (_url: string, init?: RequestInit) => {
      const stream = new ReadableStream({
        async start(controller) {
          controller.enqueue(new TextEncoder().encode(`data: ${toolCallStart(0, 'call_x', 'write', '{"path":"x.ts","content":"')}\n\n`))
          await new Promise(r => setTimeout(r, 100))
          controller.enqueue(new TextEncoder().encode(`data: ${toolCallDelta(0, 'some code')}\n\n`))
          // 给 abort 时间
          await new Promise(r => setTimeout(r, 500))
          controller.enqueue(new TextEncoder().encode(`data: ${messageEnd()}\n\n`))
          controller.close()
        }
      })
      return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    }

    const events: ChatEvent[] = []
    const iter = client.chat(
      [{ role: 'user', content: 'test' }],
      undefined,
      { abortSignal: controller.signal }
    )

    // 读完 start 和第一个 delta
    for await (const event of iter) {
      events.push(event)
      if (events.length >= 3) { // message_start + tool_call_start + tool_call_delta
        controller.abort()
        // 继续消费剩余事件
        for await (const remaining of iter) {
          events.push(remaining)
        }
        break
      }
    }

    // 应该有 cancelled 事件
    expect(events.some(e => e.type === 'cancelled')).toBe(true)

    // 不应有完整的 tool_call（因为 abort 后流中断）
    const finalToolCalls = events.filter(e => e.type === 'tool_call')
    expect(finalToolCalls.length).toBe(0)
  })

  it('第一个 chunk 不带 name 时 toolName 为空字符串', async () => {
    const client = new OpenAICompatibleModelClient(config)
    originalFetch = globalThis.fetch

    // 模拟罕见场景：第一个 chunk 只有 id 没有 function.name
    const chunkNoName = JSON.stringify({
      choices: [{
        delta: {
          tool_calls: [{ index: 0, id: 'call_no_name', function: { arguments: '{"pat' } }]
        },
        finish_reason: null
      }]
    })

    const chunkWithName = JSON.stringify({
      choices: [{
        delta: {
          tool_calls: [{ index: 0, function: { name: 'write', arguments: 'h":"a.ts"}' } }]
        },
        finish_reason: null
      }]
    })

    globalThis.fetch = async () => {
      return new Response(
        createSSEStream([chunkNoName, chunkWithName, messageEnd()]),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
      )
    }

    const events: ChatEvent[] = []
    for await (const event of client.chat([{ role: 'user', content: 'test' }])) {
      events.push(event)
    }

    const starts = events.filter(e => e.type === 'tool_call_start')
    expect(starts.length).toBe(1)
    // name 为空字符串（不是 undefined）
    if (starts[0].type === 'tool_call_start') {
      expect(starts[0].toolName).toBe('')
    }

    // 最终 tool_call 的 name 应该被后续 chunk 补上
    const finalCall = events.find(e => e.type === 'tool_call')
    expect(finalCall).toBeDefined()
    if (finalCall?.type === 'tool_call') {
      expect(finalCall.toolCall.name).toBe('write')
    }
  })
})