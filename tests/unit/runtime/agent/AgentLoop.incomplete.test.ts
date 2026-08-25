/**
 * 终态诚实行为护栏：三种停止策略截断必须如实报告为 incomplete，
 * 模型自然收工仍为 completed；incomplete 轮次与 completed 一样发 message_end
 * （不带 interrupted）、调度空闲压缩、不破坏后续轮次。
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { AgentLoop } from '../../../../src/runtime/agent/AgentLoop'
import { EventBus } from '../../../../src/runtime/agent/EventBus'
import { MockModelClient } from '../../../../src/test-support/builders/MockModelClient'
import { ToolRegistry } from '../../../../src/runtime/tools/ToolRegistry'
import { IdleCompressionTimer } from '../../../../src/runtime/agent/compaction/IdleCompressionTimer'
import type { AgentEvent } from '../../../../src/runtime/agent/types'
import type { ToolContext, ToolResult } from '../../../../src/runtime/tools/types'
import type { AgentLoopConfig } from '../../../../src/runtime/agent/types'
import { agentRoute } from '../../../../src/runtime/agent/turn'
import {
  HEADLESS_CONTINUATION_INSTRUCTION,
  headlessAssistantCompletionPolicy
} from '../../../../src/headless/completionPolicy'

const loops: AgentLoop[] = []

afterEach(() => {
  while (loops.length) loops.pop()!.dispose()
  vi.restoreAllMocks()
})

function createLoop(
  client: MockModelClient,
  config?: AgentLoopConfig
): { loop: AgentLoop; events: AgentEvent[] } {
  const eventBus = new EventBus()
  const loop = new AgentLoop(client, eventBus, {
    permissionMode: 'full_access',
    ...config
  })
  loops.push(loop)
  const events: AgentEvent[] = []
  eventBus.on(e => events.push(e))
  return { loop, events }
}

function registerTool(
  registry: ToolRegistry,
  name: string,
  impl: (args: Record<string, unknown>, ctx: ToolContext) => ToolResult | Promise<ToolResult>
): void {
  registry.register({
    name,
    description: name,
    parameters: { type: 'object', properties: {}, additionalProperties: true },
    async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      return impl(args, ctx)
    }
  })
}

/** 一轮原生工具调用响应 */
function toolCallResponse(toolCallId: string, name: string, args: string): {
  events: import('../../../../src/runtime/model/types').ChatEvent[]
} {
  return {
    events: [
      { type: 'message_start' },
      { type: 'tool_call_start', toolCallId, toolName: name, index: 0 },
      { type: 'tool_call', toolCall: { id: toolCallId, name, arguments: args } },
      { type: 'message_end', finishReason: 'tool_calls' }
    ]
  }
}

/** 断言恰好一个 message_end 且不带 interrupted、无 error 事件 */
function expectCleanMessageEnd(events: AgentEvent[]): void {
  const ends = events.filter(e => e.type === 'message_end')
  expect(ends).toHaveLength(1)
  expect((ends[0] as Extract<AgentEvent, { type: 'message_end' }>).interrupted).toBeUndefined()
  expect(events.some(e => e.type === 'error')).toBe(false)
}

describe('终态诚实：max_rounds', () => {
  it('工具轮数耗尽 → incomplete/max_rounds，message_end 无 interrupted，空闲压缩仍调度', async () => {
    const idleStart = vi.spyOn(IdleCompressionTimer.prototype, 'start')
    const client = new MockModelClient()
    client.addResponse(toolCallResponse('t1', 'ls', '{"path":"."}'))
    const registry = new ToolRegistry()
    registerTool(registry, 'ls', () => ({ success: true, output: 'ok' }))
    const { loop, events } = createLoop(client, { maxToolRounds: 1 })
    loop.setToolRegistry(registry)

    const outcome = await loop.sendMessage('列出文件', agentRoute())

    expect(outcome).toEqual({ status: 'incomplete', reason: 'max_rounds' })
    expectCleanMessageEnd(events)
    expect(loop.getState()).toBe('idle')
    expect(idleStart).toHaveBeenCalledTimes(1)
  })

  it('工具结果观测收到写入模型上下文前的完整正文', async () => {
    const client = new MockModelClient()
    client.addResponse(toolCallResponse('t1', 'large', '{}'))
    const registry = new ToolRegistry()
    const output = 'x'.repeat(9_000)
    const observed: unknown[] = []
    registerTool(registry, 'large', () => ({ success: true, output }))
    const { loop } = createLoop(client, {
      maxToolRounds: 1,
      onToolResultCommitted: (content) => observed.push(content)
    })
    loop.setToolRegistry(registry)

    await loop.sendMessage('读取完整结果', agentRoute())

    expect(observed).toEqual([output])
  })
})

describe('终态诚实：breaker', () => {
  it('相同调用在恢复提示后仍被重复 → incomplete/breaker', async () => {
    const client = new MockModelClient()
    for (let i = 0; i < 4; i += 1) {
      client.addResponse(toolCallResponse(`t${i}`, 'ls', '{"path":"."}'))
    }
    const registry = new ToolRegistry()
    registerTool(registry, 'ls', () => ({ success: false, output: '', error: 'boom' }))
    const { loop, events } = createLoop(client, { maxToolRounds: 10 })
    loop.setToolRegistry(registry)

    const outcome = await loop.sendMessage('读', agentRoute())

    expect(outcome).toEqual({ status: 'incomplete', reason: 'breaker' })
    expectCleanMessageEnd(events)
  })
})

describe('终态诚实：empty_args', () => {
  it('空参恢复提示后仍连续空参 → incomplete/empty_args', async () => {
    const client = new MockModelClient()
    client.addResponse(toolCallResponse('e0', 'ls', '{}'))
    client.addResponse(toolCallResponse('e1', 'ls', '{}'))
    client.addResponse(toolCallResponse('e2', 'ls', '{}'))
    const registry = new ToolRegistry()
    registerTool(registry, 'ls', () => ({ success: false, output: '', error: 'boom' }))
    const { loop, events } = createLoop(client, { maxToolRounds: 10 })
    loop.setToolRegistry(registry)

    const outcome = await loop.sendMessage('列', agentRoute())

    expect(outcome).toEqual({ status: 'incomplete', reason: 'empty_args' })
    expectCleanMessageEnd(events)
  })
})

describe('终态诚实：自然收工与后续轮次', () => {
  it('模型不调用工具自然收工 → completed，不带 stopReason', async () => {
    const client = new MockModelClient()
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'text_delta', delta: '好的' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })
    const { loop } = createLoop(client)

    const outcome = await loop.sendMessage('你好', agentRoute())

    expect(outcome).toEqual({ status: 'completed' })
  })

  it('未注入 completion policy 时保持仅 reasoning 的交互终态语义', async () => {
    const client = new MockModelClient()
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'thinking_delta', delta: '内部推理' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })
    const { loop } = createLoop(client)

    const outcome = await loop.sendMessage('你好', agentRoute())

    expect(outcome).toEqual({ status: 'completed' })
    expect(client.getCalls()).toHaveLength(1)
  })

  it('headless completion policy 可让仅 reasoning 的停顿继续同一次任务', async () => {
    const client = new MockModelClient()
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'thinking_delta', delta: '还需要继续实现' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'text_delta', delta: '已完成' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })
    const { loop } = createLoop(client)
    loop.setAssistantCompletionPolicy(headlessAssistantCompletionPolicy)

    const outcome = await loop.sendMessage('完成编码任务', agentRoute())

    expect(outcome).toEqual({ status: 'completed' })
    expect(client.getCalls()).toHaveLength(2)
    expect(client.getCalls()[1].messages).toContainEqual({
      role: 'user',
      content: HEADLESS_CONTINUATION_INSTRUCTION
    })
  })

  it('headless completion policy 保持正常最终正文只调用一次', async () => {
    const client = new MockModelClient()
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'thinking_delta', delta: '已经完成' },
        { type: 'text_delta', delta: '任务已完成' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })
    const { loop } = createLoop(client)
    loop.setAssistantCompletionPolicy(headlessAssistantCompletionPolicy)

    const outcome = await loop.sendMessage('完成编码任务', agentRoute())

    expect(outcome).toEqual({ status: 'completed' })
    expect(client.getCalls()).toHaveLength(1)
  })

  it('headless completion policy 在输出长度耗尽后继续同一次任务', async () => {
    const client = new MockModelClient()
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'text_delta', delta: '尚未完成的输出' },
        { type: 'message_end', finishReason: 'length' }
      ]
    })
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'text_delta', delta: '任务已完成' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })
    const { loop } = createLoop(client)
    loop.setAssistantCompletionPolicy(headlessAssistantCompletionPolicy)

    const outcome = await loop.sendMessage('完成编码任务', agentRoute())

    expect(outcome).toEqual({ status: 'completed' })
    expect(client.getCalls()).toHaveLength(2)
  })

  it('headless completion policy 不把内容过滤误当作可续跑的长度耗尽', async () => {
    const client = new MockModelClient()
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'thinking_delta', delta: '响应受限' },
        { type: 'message_end', finishReason: 'content_filter' }
      ]
    })
    const { loop } = createLoop(client)
    loop.setAssistantCompletionPolicy(headlessAssistantCompletionPolicy)

    const outcome = await loop.sendMessage('完成编码任务', agentRoute())

    expect(outcome).toEqual({ status: 'completed' })
    expect(client.getCalls()).toHaveLength(1)
  })

  it('incomplete 轮次后下一轮可继续执行并正常完成', async () => {
    const client = new MockModelClient()
    client.addResponse(toolCallResponse('t1', 'ls', '{"path":"."}'))
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'text_delta', delta: '继续' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })
    const registry = new ToolRegistry()
    registerTool(registry, 'ls', () => ({ success: true, output: 'ok' }))
    const { loop } = createLoop(client, { maxToolRounds: 1 })
    loop.setToolRegistry(registry)

    const first = await loop.sendMessage('列出文件', agentRoute())
    expect(first.status).toBe('incomplete')

    const second = await loop.sendMessage('继续', agentRoute())
    expect(second).toEqual({ status: 'completed' })
  })
})
