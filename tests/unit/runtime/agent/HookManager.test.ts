import { describe, it, expect, beforeEach } from 'vitest'
import { HookManager } from '../../../../src/runtime/agent/core/HookManager'
import { AgentLoop } from '../../../../src/runtime/agent/AgentLoop'
import { EventBus } from '../../../../src/runtime/agent/EventBus'
import { MockModelClient } from '../../../../src/test-support/builders/MockModelClient'
import type { HookEvent } from '../../../../src/runtime/agent/types'
import { executeToolBatch } from '../../../../src/runtime/agent/toolBatchExecutor'
import { ToolRegistry } from '../../../../src/runtime/tools/ToolRegistry'
import type { ToolContext, ToolResult } from '../../../../src/runtime/tools/types'

const ALL_EVENTS: HookEvent[] = [
  'onMessageStart', 'beforeAgentStart', 'preChat', 'context',
  'preToolUse', 'postToolUse', 'postMessage', 'onError', 'onCancel'
]

describe('HookManager', () => {
  let hm: HookManager

  beforeEach(() => {
    hm = new HookManager()
  })

  it('9 个事件均可注册并触发', async () => {
    const seen: HookEvent[] = []
    for (const event of ALL_EVENTS) {
      hm.on(event, ((payload: { event: HookEvent }) => {
        seen.push(payload.event)
      }) as never)
    }
    await hm.trigger({ event: 'onMessageStart', messageId: 'm1', text: 'hi' })
    await hm.trigger({ event: 'beforeAgentStart', messageId: 'm1', prompt: 'p', systemPrompt: 's' })
    await hm.trigger({ event: 'preChat', messageId: 'm1', messages: [] })
    await hm.trigger({ event: 'context', messageId: 'm1', messages: [] })
    await hm.trigger({ event: 'preToolUse', messageId: 'm1', toolCallId: 't1', toolName: 'ls', toolArgs: {} })
    await hm.trigger({ event: 'postToolUse', messageId: 'm1', toolCallId: 't1', toolName: 'ls', toolResult: 'ok', isError: false })
    await hm.trigger({ event: 'postMessage', messageId: 'm1', message: { role: 'assistant', content: 'x' } })
    await hm.trigger({ event: 'onError', messageId: 'm1', error: 'e' })
    await hm.trigger({ event: 'onCancel', messageId: 'm1', interrupted: true })
    expect(seen).toEqual(ALL_EVENTS)
  })

  it('同事件多 handler 按注册顺序执行', async () => {
    const order: number[] = []
    hm.on('onMessageStart', () => { order.push(1) })
    hm.on('onMessageStart', () => { order.push(2) })
    await hm.trigger({ event: 'onMessageStart', messageId: 'm', text: 't' })
    expect(order).toEqual([1, 2])
  })

  it('handler 抛异常被 swallow，不影响下一个', async () => {
    const order: number[] = []
    hm.on('onMessageStart', () => { throw new Error('boom') })
    hm.on('onMessageStart', () => { order.push(1) })
    await hm.trigger({ event: 'onMessageStart', messageId: 'm', text: 't' })
    expect(order).toEqual([1])
  })

  it('handler 抛异常不影响主循环', async () => {
    const client = new MockModelClient()
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'text_delta', delta: 'ok' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })
    const bus = new EventBus()
    const loop = new AgentLoop(client, bus)
    loop.getHookManager().on('onMessageStart', () => { throw new Error('hook fail') })
    await loop.sendMessage('hello')
    expect(loop.getState()).toBe('idle')
  })

  it('preToolUse modifiedArgs 传到工具执行', async () => {
    const registry = new ToolRegistry()
    registry.register({
      name: 'echo',
      description: 'echo',
      parameters: { type: 'object', properties: {} },
      async execute(args: Record<string, unknown>): Promise<ToolResult> {
        return { success: true, output: String(args.patched ?? '') }
      }
    })
    const hm2 = new HookManager()
    hm2.on('preToolUse', () => ({ modifiedArgs: { patched: 'yes' } }))
    const result = await executeToolBatch({
      toolCalls: [{ id: 'c1', name: 'echo', arguments: '{}' }],
      messageId: 'm',
      toolRegistry: registry,
      workingDir: process.cwd(),
      mode: 'default',
      supportsVision: false,
      checkpointManager: null,
      abortSignal: undefined,
      checkPermission: async () => ({ allowed: true, reason: '' }),
      emit: () => {},
      applyTruncation: (o) => o,
      maxParallelToolCalls: 1,
      toolExecution: 'sequential',
      hookManager: hm2
    })
    expect(result.outcomes[0].resultText).toBe('yes')
  })

  it('preToolUse block 跳过工具执行', async () => {
    const registry = new ToolRegistry()
    let executed = false
    registry.register({
      name: 'echo',
      description: 'echo',
      parameters: { type: 'object', properties: {} },
      async execute(): Promise<ToolResult> {
        executed = true
        return { success: true, output: 'x' }
      }
    })
    const hm2 = new HookManager()
    hm2.on('preToolUse', () => ({ block: true, reason: 'denied' }))
    await executeToolBatch({
      toolCalls: [{ id: 'c1', name: 'echo', arguments: '{}' }],
      messageId: 'm',
      toolRegistry: registry,
      workingDir: process.cwd(),
      mode: 'default',
      supportsVision: false,
      checkpointManager: null,
      abortSignal: undefined,
      checkPermission: async () => ({ allowed: true, reason: '' }),
      emit: () => {},
      applyTruncation: (o) => o,
      maxParallelToolCalls: 1,
      toolExecution: 'sequential',
      hookManager: hm2
    })
    expect(executed).toBe(false)
  })

  it('onCancel payload 含 interrupted: true', async () => {
    let payload: unknown
    hm.on('onCancel', (p) => { payload = p })
    await hm.trigger({ event: 'onCancel', messageId: 'm', interrupted: true })
    expect(payload).toMatchObject({ interrupted: true })
  })

  it('clear(event) 只清指定事件', () => {
    hm.on('onMessageStart', () => {})
    hm.on('onError', () => {})
    hm.clear('onMessageStart')
    expect(hm.count('onMessageStart')).toBe(0)
    expect(hm.count('onError')).toBe(1)
  })

  it('clear() 不传参清空全部', () => {
    hm.on('onMessageStart', () => {})
    hm.on('onError', () => {})
    hm.clear()
    expect(hm.count()).toBe(0)
  })

  it('count() 准确统计', () => {
    hm.on('onMessageStart', () => {})
    hm.on('onMessageStart', () => {})
    hm.on('onError', () => {})
    expect(hm.count('onMessageStart')).toBe(2)
    expect(hm.count()).toBe(3)
  })

  it('hook 异常时发射 hook_error 事件', async () => {
    const bus = new EventBus()
    const hmBus = new HookManager(bus)
    const errors: unknown[] = []
    bus.on((e) => { if (e.type === 'hook_error') errors.push(e) })
    hmBus.on('onError', () => { throw new Error('kaput') })
    await hmBus.trigger({ event: 'onError', messageId: 'm', error: 'x' })
    expect(errors).toHaveLength(1)
  })
})
