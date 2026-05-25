import { describe, it, expect } from 'vitest'
import { AgentLoop } from '../../../src/runtime/agent/AgentLoop'
import { EventBus } from '../../../src/runtime/agent/EventBus'
import { MockModelClient } from '../../../src/test-support/builders/MockModelClient'
import { ToolRegistry } from '../../../src/runtime/tools/ToolRegistry'
import { PermissionManager } from '../../../src/runtime/permissions/PermissionManager'
import type { ToolContext, ToolResult } from '../../../src/runtime/tools/types'

/** 创建一个包含 ls 工具的测试 Registry */
function createTestRegistry(): ToolRegistry {
  const registry = new ToolRegistry()
  registry.register({
    name: 'ls',
    description: '列出目录',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '目录路径' }
      }
    },
    async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
      return { success: true, output: `目录内容: ${args.path ?? '.'}` }
    }
  })
  return registry
}

describe('AgentLoop', () => {
  function createLoop(mockClient?: MockModelClient) {
    const client = mockClient ?? new MockModelClient()
    const eventBus = new EventBus()
    const loop = new AgentLoop(client, eventBus)
    loop.setToolRegistry(createTestRegistry())
    return { loop, eventBus, client }
  }

  it('初始状态为 idle', () => {
    const { loop } = createLoop()
    expect(loop.getState()).toBe('idle')
  })

  it('sendMessage 产出一轮完整的消息事件', async () => {
    const client = new MockModelClient()
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'text_delta', delta: '你好' },
        { type: 'text_delta', delta: '世界' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })

    const { loop, eventBus } = createLoop(client)
    const events: unknown[] = []
    eventBus.on((e) => events.push(e))

    await loop.sendMessage('hello')

    // message_start + 2 * text_delta + message_end
    expect(events.filter((e: any) => e.type === 'message_start')).toHaveLength(1)
    expect(events.filter((e: any) => e.type === 'text_delta')).toHaveLength(2)
    expect(events.filter((e: any) => e.type === 'message_end')).toHaveLength(1)
    expect(loop.getState()).toBe('idle')
  })

  it('sendMessage 将对话上下文传给模型', async () => {
    const client = new MockModelClient()
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })

    const { loop } = createLoop(client)
    await loop.sendMessage('第一条消息')

    // 第一次调用：system prompt + 用户消息
    const calls = client.getCalls()
    expect(calls).toHaveLength(1)
    expect(calls[0].messages[0].role).toBe('system')
    expect(calls[0].messages[1]).toEqual({ role: 'user', content: '第一条消息' })
  })

  it('连续发送消息，上下文累积增长', async () => {
    const client = new MockModelClient()
    // 第一轮
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'text_delta', delta: '回复1' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })
    // 第二轮
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'text_delta', delta: '回复2' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })

    const { loop } = createLoop(client)
    await loop.sendMessage('问题1')
    await loop.sendMessage('问题2')

    const calls = client.getCalls()
    // 第二次调用：system + user1 + assistant1 + user2
    expect(calls[1].messages).toHaveLength(4)
    expect(calls[1].messages[2]).toEqual({ role: 'assistant', content: '回复1' })
    expect(calls[1].messages[3]).toEqual({ role: 'user', content: '问题2' })
  })

  it('模型错误时发射 error 事件并进入 error 状态', async () => {
    const client = new MockModelClient()
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'error', error: 'API 错误 401' }
      ]
    })

    const { loop, eventBus } = createLoop(client)
    const events: unknown[] = []
    eventBus.on((e) => events.push(e))

    await loop.sendMessage('hello')

    expect(events.some((e: any) => e.type === 'error')).toBe(true)
    expect(loop.getState()).toBe('error')
  })

  it('cancel 中断正在执行的循环', async () => {
    const client = new MockModelClient()
    // 模拟一个很长的响应
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'text_delta', delta: '开始...' }
        // 没有 message_end，模拟被取消
      ]
    })

    const { loop, eventBus } = createLoop(client)
    const events: unknown[] = []
    eventBus.on((e) => events.push(e))

    // 启动后立即取消
    const promise = loop.sendMessage('hello')
    loop.cancel()
    await promise

    expect(loop.getState()).toBe('cancelled')
  })

  it('重复发送时拒绝并发射 error', async () => {
    const client = new MockModelClient()
    // 模拟不会自行结束的响应
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'text_delta', delta: '思考中...' }
      ]
    })

    const { loop, eventBus } = createLoop(client)
    const events: unknown[] = []
    eventBus.on((e) => events.push(e))

    // 第一个调用不 await，让它挂着
    loop.sendMessage('first')

    // 第二个调用应该被拒绝
    await loop.sendMessage('second')

    const errorEvents = events.filter((e: any) => e.type === 'error')
    expect(errorEvents.length).toBeGreaterThanOrEqual(1)
  })

  it('reset 清空上下文并回到 idle', async () => {
    const client = new MockModelClient()
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'text_delta', delta: 'hi' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })

    const { loop } = createLoop(client)
    await loop.sendMessage('hello')
    expect(loop.getContext().length).toBeGreaterThan(1)

    loop.reset()
    // reset 后只有 system prompt
    expect(loop.getContext()).toHaveLength(1)
    expect(loop.getState()).toBe('idle')
  })

  // ── 工具调度测试（S4） ──────────────────────────────────

  it('模型调用工具时，执行工具并将结果回传模型', async () => {
    const client = new MockModelClient()
    // 第一轮：模型调用 ls 工具
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'text_delta', delta: '让我看看目录结构...' },
        {
          type: 'tool_call',
          toolCall: { id: 'call_1', name: 'ls', arguments: '{"path":"."}' }
        },
        { type: 'message_end', finishReason: 'tool_calls' }
      ]
    })
    // 第二轮：模型拿到工具结果后回复
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'text_delta', delta: '目录已列出。' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })

    const { loop, eventBus } = createLoop(client)
    const events: unknown[] = []
    eventBus.on((e) => events.push(e))

    await loop.sendMessage('列出当前目录')

    // 应该有 tool_call 和 tool_result 事件
    const toolCallEvents = events.filter((e: any) => e.type === 'tool_call')
    const toolResultEvents = events.filter((e: any) => e.type === 'tool_result')
    expect(toolCallEvents.length).toBeGreaterThanOrEqual(1)
    expect(toolResultEvents.length).toBeGreaterThanOrEqual(1)

    // 模型应该被调用两次（第一次返回 tool_call，第二次收到结果后最终回复）
    expect(client.getCalls()).toHaveLength(2)
  })

  it('工具结果以 tool 消息回传模型', async () => {
    const client = new MockModelClient()
    client.addResponse({
      events: [
        { type: 'message_start' },
        {
          type: 'tool_call',
          toolCall: { id: 'call_1', name: 'ls', arguments: '{"path":"."}' }
        },
        { type: 'message_end', finishReason: 'tool_calls' }
      ]
    })
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })

    const { loop } = createLoop(client)
    await loop.sendMessage('列出目录')

    // 第二次调用中，最后一条消息应该是 tool 消息
    const secondCall = client.getCalls()[1]
    const lastMsg = secondCall.messages[secondCall.messages.length - 1]
    expect(lastMsg.role).toBe('tool')
    expect(lastMsg.toolCallId).toBe('call_1')
  })

  it('达到 maxToolRounds 时停止工具调度', async () => {
    const client = new MockModelClient()
    // 模型一直调用工具（死循环场景）
    for (let i = 0; i < 5; i++) {
      client.addResponse({
        events: [
          { type: 'message_start' },
          {
            type: 'tool_call',
            toolCall: { id: `call_${i}`, name: 'ls', arguments: '{"path":"."}' }
          },
          { type: 'message_end', finishReason: 'tool_calls' }
        ]
      })
    }

    const { loop, eventBus } = createLoop(client)
    // 设置最大工具轮数为 2
    loop.setToolRegistry(createTestRegistry())
    loop.setMaxToolRounds(2)

    const events: unknown[] = []
    eventBus.on((e) => events.push(e))

    await loop.sendMessage('列出目录')

    // 工具调用次数不应超过 2
    const toolCallEvents = events.filter((e: any) => e.type === 'tool_call')
    expect(toolCallEvents.length).toBeLessThanOrEqual(2)
  })

  it('未注册的工具返回错误结果', async () => {
    const client = new MockModelClient()
    client.addResponse({
      events: [
        { type: 'message_start' },
        {
          type: 'tool_call',
          toolCall: { id: 'call_1', name: 'nonexistent_tool', arguments: '{}' }
        },
        { type: 'message_end', finishReason: 'tool_calls' }
      ]
    })
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'text_delta', delta: '好的' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })

    const { loop, eventBus } = createLoop(client)
    const events: unknown[] = []
    eventBus.on((e) => events.push(e))

    await loop.sendMessage('执行不存在的工具')

    const toolResultEvents = events.filter((e: any) => e.type === 'tool_result')
    expect(toolResultEvents.length).toBe(1)
    // 工具结果应该包含错误信息
    expect((toolResultEvents[0] as any).result).toContain('未注册')
  })

  it('default 模式下 bash 需要权限确认，允许后才执行工具', async () => {
    const client = new MockModelClient()
    client.addResponse({
      events: [
        { type: 'message_start' },
        {
          type: 'tool_call',
          toolCall: { id: 'call_bash_1', name: 'bash', arguments: '{"command":"npm test"}' }
        },
        { type: 'message_end', finishReason: 'tool_calls' }
      ]
    })
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'text_delta', delta: '验证完成。' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })

    const registry = new ToolRegistry()
    registry.register({
      name: 'bash',
      description: '执行 shell 命令',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'shell 命令' }
        },
        required: ['command']
      },
      async execute(args: Record<string, unknown>): Promise<ToolResult> {
        return { success: true, output: `bash ok: ${args.command}` }
      }
    })

    const eventBus = new EventBus()
    const loop = new AgentLoop(client, eventBus)
    loop.setToolRegistry(registry)
    loop.setMode('default')
    loop.setPermissionManager(new PermissionManager())

    const events: unknown[] = []
    eventBus.on((event) => {
      events.push(event)
      if ((event as any).type === 'permission_request') {
        loop.respondPermission((event as any).requestId, true)
      }
    })

    await loop.sendMessage('执行测试命令')

    const permissionEvents = events.filter((e: any) => e.type === 'permission_request')
    expect(permissionEvents).toHaveLength(1)

    const toolResultEvents = events.filter((e: any) => e.type === 'tool_result')
    expect(toolResultEvents).toHaveLength(1)
    expect((toolResultEvents[0] as any).result).toContain('bash ok: npm test')
  })

  it('default 模式下用户拒绝 bash 权限后，应把拒绝结果回传模型', async () => {
    const client = new MockModelClient()
    client.addResponse({
      events: [
        { type: 'message_start' },
        {
          type: 'tool_call',
          toolCall: { id: 'call_bash_2', name: 'bash', arguments: '{"command":"npm run build"}' }
        },
        { type: 'message_end', finishReason: 'tool_calls' }
      ]
    })
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'text_delta', delta: '收到，改用别的方法。' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })

    const registry = new ToolRegistry()
    registry.register({
      name: 'bash',
      description: '执行 shell 命令',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'shell 命令' }
        },
        required: ['command']
      },
      async execute(): Promise<ToolResult> {
        return { success: true, output: '不应执行到这里' }
      }
    })

    const eventBus = new EventBus()
    const loop = new AgentLoop(client, eventBus)
    loop.setToolRegistry(registry)
    loop.setMode('default')
    loop.setPermissionManager(new PermissionManager())

    const events: unknown[] = []
    eventBus.on((event) => {
      events.push(event)
      if ((event as any).type === 'permission_request') {
        loop.respondPermission((event as any).requestId, false)
      }
    })

    await loop.sendMessage('执行构建命令')

    const toolResultEvents = events.filter((e: any) => e.type === 'tool_result')
    expect(toolResultEvents).toHaveLength(1)
    expect((toolResultEvents[0] as any).result).toContain('权限拒绝:')
    expect((toolResultEvents[0] as any).result).toContain('用户拒绝了 "bash" 工具的执行请求')
  })

  /**
   * T3 回归：用户在权限确认期间点取消（cancel）时，
   * 不应再产生"权限拒绝"的 tool_result，也不应把该工具调用 push 到 context。
   * 历史回放因此不会出现莫名其妙的"权限拒绝"卡片。
   */
  it('cancel 在权限确认期间不应产生权限拒绝的 tool_result', async () => {
    const client = new MockModelClient()
    client.addResponse({
      events: [
        { type: 'message_start' },
        {
          type: 'tool_call',
          toolCall: { id: 'call_bash_cancel', name: 'bash', arguments: '{"command":"sleep 100"}' }
        },
        { type: 'message_end', finishReason: 'tool_calls' }
      ]
    })

    const registry = new ToolRegistry()
    registry.register({
      name: 'bash',
      description: '执行 shell 命令',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'shell 命令' }
        },
        required: ['command']
      },
      async execute(): Promise<ToolResult> {
        return { success: true, output: '不应执行' }
      }
    })

    const eventBus = new EventBus()
    const loop = new AgentLoop(client, eventBus)
    loop.setToolRegistry(registry)
    loop.setMode('default')
    loop.setPermissionManager(new PermissionManager())

    const events: unknown[] = []
    eventBus.on((event) => {
      events.push(event)
      // 收到权限请求时不应答，转而调用 cancel
      if ((event as any).type === 'permission_request') {
        loop.cancel()
      }
    })

    await loop.sendMessage('执行需要权限的命令')

    // 关键断言：
    // 1. 不应有 tool_result 事件被发出（更别说"权限拒绝"字样）
    const toolResultEvents = events.filter((e: any) => e.type === 'tool_result')
    expect(toolResultEvents).toHaveLength(0)

    // 2. context 中不应包含 role: 'tool' 的消息
    const ctxToolMessages = loop.getContext().filter(m => m.role === 'tool')
    expect(ctxToolMessages).toHaveLength(0)

    // 3. 状态应为 cancelled
    expect(loop.getState()).toBe('cancelled')
  })
})
