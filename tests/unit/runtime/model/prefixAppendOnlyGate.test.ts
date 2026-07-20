/**
 * 前缀 append-only 门禁（TDD：当前必败，A1 修复后转绿）
 *
 * 验证 cache epoch 内相邻请求的前缀不变量：
 * - wire 层：mock fetch 捕获真实 HTTP 请求体，规范化后断言逐字节前缀
 * - 运行时层：MockModelClient 捕获 ChatMessage 数组，深快照断言语义不变
 *
 * 固定条件：同一模型 / 同一 endpoint / 同一工具集，
 * 不发生压缩 / fallback / abort / 分叉 / 能力降级。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { OpenAICompatibleModelClient } from '../../../../src/runtime/model/OpenAICompatibleModelClient'
import { AgentLoop } from '../../../../src/runtime/agent/AgentLoop'
import { EventBus } from '../../../../src/runtime/agent/EventBus'
import { ToolRegistry } from '../../../../src/runtime/tools/ToolRegistry'
import { MockModelClient } from '../../../../src/test-support/builders/MockModelClient'
import { canonicalizeForCacheComparison } from '../../../../src/runtime/model/cacheCanonicalize'
import type { ToolResult } from '../../../../src/runtime/tools/types'

const TURNS = 12
const READ_PATH = '/src/app.ts'
/** >8KB，触发 aging 阈值 */
const LARGE_OUTPUT = 'x'.repeat(10 * 1024)

function registerReadTool(registry: ToolRegistry): void {
  registry.register({
    name: 'read',
    description: '读取文件',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path']
    },
    async execute(): Promise<ToolResult> {
      return { success: true, output: LARGE_OUTPUT }
    }
  })
}

// ── wire 层：mock fetch + SSE 流 ──────────────────────────

let fetchCallCount = 0

function makeSseStream(): ReadableStream {
  fetchCallCount++
  const encoder = new TextEncoder()
  const isToolCall = fetchCallCount % 2 === 1
  const tcId = `tc_${Math.ceil(fetchCallCount / 2)}`

  return new ReadableStream({
    start(controller) {
      if (isToolCall) {
        const args = JSON.stringify({ path: READ_PATH })
        controller.enqueue(encoder.encode(
          `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"${tcId}","function":{"name":"read","arguments":${JSON.stringify(args)}}}]},"finish_reason":null}]}\n\n`
        ))
        controller.enqueue(encoder.encode(
          'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n'
        ))
      } else {
        controller.enqueue(encoder.encode(
          'data: {"choices":[{"delta":{"content":"已读取文件内容。"},"finish_reason":"stop"}]}\n\n'
        ))
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      controller.close()
    }
  })
}

function interceptFetch(): {
  bodies: Array<Record<string, unknown>>
  restore: () => void
} {
  const originalFetch = globalThis.fetch
  const bodies: Array<Record<string, unknown>> = []
  fetchCallCount = 0
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(init!.body as string))
    return new Response(makeSseStream(), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' }
    })
  }
  return { bodies, restore: () => { globalThis.fetch = originalFetch } }
}

// ── wire 层门禁 ──────────────────────────────────────────

describe('wire 层 append-only 门禁（当前必败，A1 后转绿）', () => {
  let interceptor: ReturnType<typeof interceptFetch> | null = null
  const loops: AgentLoop[] = []

  afterEach(() => {
    interceptor?.restore()
    interceptor = null
    for (const l of loops) l.dispose()
    loops.length = 0
  })

  it('同会话 10+ 轮重复 read：相邻请求 messages 逐字节前缀', async () => {
    interceptor = interceptFetch()

    const client = new OpenAICompatibleModelClient({
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'test-key',
      modelId: 'deepseek-chat'
    })

    const loop = new AgentLoop(client, new EventBus(), {
      contextWindow: 1_000_000
    })
    loops.push(loop)

    const registry = new ToolRegistry()
    registerReadTool(registry)
    loop.setToolRegistry(registry)

    for (let i = 0; i < TURNS; i++) {
      await loop.sendMessage(`第 ${i + 1} 轮：请读取 ${READ_PATH}`)
    }

    // 每轮 2 次 fetch（tool_call 响应 + text 响应）
    expect(interceptor.bodies.length).toBe(TURNS * 2)

    for (let i = 1; i < interceptor.bodies.length; i++) {
      const prev = canonicalizeForCacheComparison(interceptor.bodies[i - 1], 'deepseek')
      const curr = canonicalizeForCacheComparison(interceptor.bodies[i], 'deepseek')

      const prevMsgs = prev.messages as unknown[]
      const currMsgs = curr.messages as unknown[]

      expect(currMsgs.length).toBeGreaterThanOrEqual(prevMsgs.length)
      expect(
        JSON.stringify(currMsgs.slice(0, prevMsgs.length)),
        `请求 ${i - 1} → ${i}：前一次 messages 不是后一次的逐字节前缀`
      ).toBe(JSON.stringify(prevMsgs))
    }
  })

  it('恢复路径：独立 epoch，不与轮内断言混用', async () => {
    interceptor = interceptFetch()

    const client = new OpenAICompatibleModelClient({
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'test-key',
      modelId: 'deepseek-chat'
    })

    const loop1 = new AgentLoop(client, new EventBus(), { contextWindow: 1_000_000 })
    loops.push(loop1)
    const registry1 = new ToolRegistry()
    registerReadTool(registry1)
    loop1.setToolRegistry(registry1)

    await loop1.sendMessage('第 1 轮')
    await loop1.sendMessage('第 2 轮')

    const bodiesBeforeRestore = interceptor.bodies.length

    // 新 loop = 独立 epoch，不与前一个 loop 的请求做前缀比较
    const loop2 = new AgentLoop(client, new EventBus(), { contextWindow: 1_000_000 })
    loops.push(loop2)
    const registry2 = new ToolRegistry()
    registerReadTool(registry2)
    loop2.setToolRegistry(registry2)

    await loop2.sendMessage('恢复后第 1 轮')

    // 恢复后的请求之间仍满足前缀不变量（同 epoch 内）
    const restoreBodies = interceptor.bodies.slice(bodiesBeforeRestore)
    for (let i = 1; i < restoreBodies.length; i++) {
      const prev = canonicalizeForCacheComparison(restoreBodies[i - 1], 'deepseek')
      const curr = canonicalizeForCacheComparison(restoreBodies[i], 'deepseek')
      const prevMsgs = prev.messages as unknown[]
      const currMsgs = curr.messages as unknown[]
      expect(
        JSON.stringify(currMsgs.slice(0, prevMsgs.length))
      ).toBe(JSON.stringify(prevMsgs))
    }
  })
})

// ── 运行时消息层门禁 ─────────────────────────────────────

describe('运行时消息层 append-only 门禁（当前必败，A1 后转绿）', () => {
  const loops: AgentLoop[] = []

  afterEach(() => {
    for (const l of loops) l.dispose()
    loops.length = 0
  })

  it('重复 read 同路径：既有消息逐条语义不变，新消息只在尾部', async () => {
    const client = new MockModelClient()

    for (let i = 0; i < TURNS; i++) {
      const tcId = `tc_${i + 1}`
      client.addResponse({
        events: [
          { type: 'message_start' },
          { type: 'tool_call_start', toolCallId: tcId, toolName: 'read', index: 0 },
          { type: 'tool_call_delta', toolCallId: tcId, argumentsDelta: JSON.stringify({ path: READ_PATH }) },
          { type: 'tool_call', toolCall: { id: tcId, name: 'read', arguments: JSON.stringify({ path: READ_PATH }) } },
          { type: 'message_end', finishReason: 'tool_calls' }
        ]
      })
      client.addResponse({
        events: [
          { type: 'message_start' },
          { type: 'text_delta', delta: '已读取文件内容。' },
          { type: 'message_end', finishReason: 'stop' }
        ]
      })
    }

    const loop = new AgentLoop(client, new EventBus(), { contextWindow: 1_000_000 })
    loops.push(loop)

    const registry = new ToolRegistry()
    registerReadTool(registry)
    loop.setToolRegistry(registry)

    for (let i = 0; i < TURNS; i++) {
      await loop.sendMessage(`第 ${i + 1} 轮：请读取 ${READ_PATH}`)
    }

    const calls = client.getCalls()
    expect(calls.length).toBe(TURNS * 2)

    // 相邻调用的 messages 满足前缀不变量：既有消息逐条语义不变，新消息只在尾部
    for (let i = 1; i < calls.length; i++) {
      const prev = calls[i - 1].messages
      const curr = calls[i].messages

      expect(curr.length).toBeGreaterThanOrEqual(prev.length)

      for (let j = 0; j < prev.length; j++) {
        expect(
          JSON.stringify(curr[j]),
          `消息 [${j}] 在调用 ${i - 1} → ${i} 间被改写`
        ).toBe(JSON.stringify(prev[j]))
      }
    }
  })
})
