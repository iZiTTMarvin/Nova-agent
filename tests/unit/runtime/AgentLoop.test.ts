import { describe, it, expect, vi } from 'vitest'
import { AgentLoop } from '../../../src/runtime/agent/AgentLoop'
import { EventBus } from '../../../src/runtime/agent/EventBus'
import { IdleCompressionTimer } from '../../../src/runtime/agent/compaction/IdleCompressionTimer'
import { MockModelClient } from '../../../src/test-support/builders/MockModelClient'
import { ToolRegistry } from '../../../src/runtime/tools/ToolRegistry'
import { PermissionManager } from '../../../src/runtime/permissions/PermissionManager'
import type { ToolContext, ToolResult } from '../../../src/runtime/tools/types'
import { extractTextFromContent } from '../../../src/runtime/model/types'
import type { ChatMessage } from '../../../src/runtime/model/types'
import { estimateContextTokens } from '../../../src/runtime/agent/tokenEstimator'
import { AGING_GROUP_BYTES_THRESHOLD } from '../../../src/runtime/agent/compaction/toolResultAging'
import { SkillRegistry } from '../../../src/runtime/skills/SkillRegistry'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

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

    // 第一次调用：system prompt + 用户消息（session context 拼在 user content 前缀）
    const calls = client.getCalls()
    expect(calls).toHaveLength(1)
    expect(calls[0].messages[0].role).toBe('system')
    expect(calls[0].messages[1].role).toBe('user')
    // session context 前缀拼在 user 消息 content 中（合并方案，不增加消息条数）
    expect(typeof calls[0].messages[1].content).toBe('string')
    expect(calls[0].messages[1].content as string).toContain('[Session context:')
    expect(calls[0].messages[1].content as string).toContain('第一条消息')
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
    // 第二次调用：system + user1（含 session context 前缀） + assistant1 + user2
    expect(calls[1].messages).toHaveLength(4)
    expect(calls[1].messages[2]).toEqual({ role: 'assistant', content: '回复1' })
    expect(calls[1].messages[3].role).toBe('user')
    expect(calls[1].messages[3].content).toContain('问题2')
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

  it('finish_reason 为 stop 但携带 tool_calls 时仍执行工具', async () => {
    const client = new MockModelClient()
    client.addResponse({
      events: [
        { type: 'message_start' },
        {
          type: 'tool_call',
          toolCall: { id: 'call_stop', name: 'ls', arguments: '{"path":"."}' }
        },
        // 部分 provider 在 native tool_calls 时仍返回 stop
        { type: 'message_end', finishReason: 'stop' }
      ]
    })
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'text_delta', delta: '完成' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })

    const { loop, eventBus } = createLoop(client)
    const events: unknown[] = []
    eventBus.on((e) => events.push(e))

    await loop.sendMessage('列出目录')

    expect(events.filter((e: { type?: string }) => e.type === 'tool_result').length).toBeGreaterThanOrEqual(1)
    expect(client.getCalls()).toHaveLength(2)
  })

  it('模型把工具调用误写成 JSON 文本时，仍会兜底解析并继续对话', async () => {
    const client = new MockModelClient()
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'text_delta', delta: '我来看看当前目录。\n\n' },
        {
          type: 'text_delta',
          delta: '```json\n{"name":"list_directory","arguments":{"path":"."}}\n```'
        },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })
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

    expect(client.getCalls()).toHaveLength(2)
    expect(events.some((e: any) => e.type === 'tool_call' && e.toolName === 'ls')).toBe(true)

    const context = loop.getContext()
    const assistantWithTool = context.find(
      m => m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length > 0
    )
    expect(assistantWithTool?.content).toBe('我来看看当前目录。')

    const secondCall = client.getCalls()[1]
    const lastMsg = secondCall.messages[secondCall.messages.length - 1]
    expect(lastMsg.role).toBe('tool')
  })
  it('模型把多个工具调用混在正文 JSON 中时，兜底解析多个 tool_call', async () => {
    const client = new MockModelClient()
    client.addResponse({
      events: [
        { type: 'message_start' },
        {
          type: 'text_delta',
          delta: '我先看目录结构。{ "name": "directory_tree", "arguments": { "path": ".", "max_depth": 2 } } 然后读 README。{ "name": "read_file", "arguments": { "path": "README.md" } }'
        },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'text_delta', delta: '已完成查看。' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })

    const { loop, eventBus } = createLoop(client)
    const events: unknown[] = []
    eventBus.on((e) => events.push(e))

    await loop.sendMessage('当前项目什么情况')

    expect(client.getCalls()).toHaveLength(2)

    const toolCallEvents = events.filter((e: any) => e.type === 'tool_call')
    expect(toolCallEvents).toHaveLength(2)
    expect(toolCallEvents.map((e: any) => e.toolName)).toContain('ls')
    expect(toolCallEvents.map((e: any) => e.toolName)).toContain('read')

    const context = loop.getContext()
    const assistantWithTool = context.find(
      m => m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length > 0
    )
    expect(assistantWithTool?.toolCalls).toHaveLength(2)
  })

  it('模型输出 MiniMax XML 风格调用时，兜底解析并执行', async () => {
    const client = new MockModelClient()
    client.addResponse({
      events: [
        { type: 'message_start' },
        {
          type: 'text_delta',
          delta: '让我执行命令。<invoke name="bash"><command>dir</command><description>List files</description></invoke>'
        },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'text_delta', delta: '命令执行完毕。' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })

    const { loop, eventBus } = createLoop(client)
    const events: unknown[] = []
    eventBus.on((e) => events.push(e))

    await loop.sendMessage('列出文件')

    expect(client.getCalls()).toHaveLength(2)
    expect(events.some((e: any) => e.type === 'tool_call' && e.toolName === 'bash')).toBe(true)
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

  it('只读工具并发完成顺序可乱序，但写回上下文时仍按原始 tool_call 顺序', async () => {
    const client = new MockModelClient()
    const releaseRead = (() => {
      let resolve!: () => void
      const promise = new Promise<void>(res => { resolve = res })
      return { promise, resolve }
    })()

    client.addResponse({
      events: [
        { type: 'message_start' },
        {
          type: 'tool_call',
          toolCall: { id: 'call_read', name: 'read', arguments: '{"path":"a.txt"}' }
        },
        {
          type: 'tool_call',
          toolCall: { id: 'call_grep', name: 'grep', arguments: '{"pattern":"foo"}' }
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

    const registry = new ToolRegistry()
    registry.register({
      name: 'read',
      description: '读取文件',
      executionMode: 'parallel',
      isConcurrencySafe: () => true,
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
      async execute(): Promise<ToolResult> {
        await releaseRead.promise
        return { success: true, output: 'read ok' }
      }
    })
    registry.register({
      name: 'grep',
      description: '搜索',
      executionMode: 'parallel',
      isConcurrencySafe: () => true,
      parameters: { type: 'object', properties: { pattern: { type: 'string' } } },
      async execute(): Promise<ToolResult> {
        return { success: true, output: 'grep ok' }
      }
    })

    const eventBus = new EventBus()
    const loop = new AgentLoop(client, eventBus)
    loop.setToolRegistry(registry)

    const events: string[] = []
    eventBus.on((event) => {
      if (event.type === 'tool_result') {
        events.push(event.toolCallId)
      }
    })

    const promise = loop.sendMessage('并发读取')
    await new Promise(resolve => setTimeout(resolve, 0))
    releaseRead.resolve()
    await promise

    expect(events).toEqual(['call_grep', 'call_read'])

    const toolMessages = loop.getContext().filter(m => m.role === 'tool')
    expect(toolMessages).toHaveLength(2)
    expect(toolMessages[0].toolCallId).toBe('call_read')
    expect(toolMessages[0].content).toBe('read ok')
    expect(toolMessages[1].toolCallId).toBe('call_grep')
    expect(toolMessages[1].content).toBe('grep ok')
  })

  it('read 工具返回 images 时，tool 消息会写入多模态 ContentBlock 数组', async () => {
    const client = new MockModelClient()
    client.addResponse({
      events: [
        { type: 'message_start' },
        {
          type: 'tool_call',
          toolCall: { id: 'call_read_img', name: 'read', arguments: '{"path":"image.png"}' }
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

    const registry = new ToolRegistry()
    registry.register({
      name: 'read',
      description: '读取图片',
      executionMode: 'parallel',
      isConcurrencySafe: () => true,
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
      async execute(): Promise<ToolResult> {
        return {
          success: true,
          output: '已读取图片文件 [image/png]',
          images: [{ data: 'ZmFrZS1pbWFnZQ==', mimeType: 'image/png' }]
        }
      }
    })

    const eventBus = new EventBus()
    const loop = new AgentLoop(client, eventBus)
    loop.setToolRegistry(registry)

    await loop.sendMessage('读取图片')

    const toolMessages = loop.getContext().filter(m => m.role === 'tool')
    expect(toolMessages).toHaveLength(1)
    const toolContent = toolMessages[0].content
    expect(Array.isArray(toolContent)).toBe(true)
    if (Array.isArray(toolContent)) {
      expect(toolContent[0]).toEqual({ type: 'text', text: '已读取图片文件 [image/png]' })
      expect(toolContent[1]).toEqual({
        type: 'image_url',
        image_url: { url: 'data:image/png;base64,ZmFrZS1pbWFnZQ==' }
      })
    }
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

    // 达到上限时应下发提示文案（不再静默退出）
    const noticed = events.some(
      (e: any) =>
        e.type === 'text_delta' &&
        typeof e.delta === 'string' &&
        e.delta.includes('已达到最大工具调用轮数')
    )
    expect(noticed).toBe(true)
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

  /**
   * P2 回归：压缩时上下文末尾为 user 消息，应插入 assistant 桥接，
   * 避免连续两条 user 消息导致 Anthropic 严格模式 400 错误。
   */
  it('压缩时上下文以 user 结尾，模型收到的压缩上下文不会出现连续 user', async () => {
    const client = new MockModelClient()
    // 第一轮：正常回复（不触发压缩）
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'text_delta', delta: '好的' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })
    // 压缩调用：模型生成摘要
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'text_delta', delta: '这是对话摘要。' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })
    // 压缩后的正常回复
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'text_delta', delta: '继续' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })

    const eventBus = new EventBus()
    const loop = new AgentLoop(client, eventBus, {
      systemPrompt: '你是助手。',
      maxToolRounds: 20,
      onCompaction: (_ctx, _meta) => {}
    })
    loop.setToolRegistry(createTestRegistry())

    // 注入足够多的历史消息（> MIN_RECENT_MESSAGES + 2 = 22 条）且总 token > 阈值
    // 以触发压缩
    const history: ChatMessage[] = []
    for (let i = 0; i < 24; i++) {
      history.push(
        { role: 'user', content: 'x'.repeat(20_000) },
        { role: 'assistant', content: 'y'.repeat(20_000) }
      )
    }
    loop.injectHistory(history)

    // 发送第二条消息，此时上下文总长 > 阈值，会触发压缩
    // 上下文此时以 user 消息结尾（刚 push 的 user 消息）
    await loop.sendMessage('触发压缩')

    // 找到压缩调用（包含"请对上面的对话历史"的消息）
    const calls = client.getCalls()
    const compactionCall = calls.find(c =>
      c.messages.some(m => m.role === 'user' && extractTextFromContent(m.content).includes('请对上面的对话历史'))
    )
    expect(compactionCall).toBeDefined()
    expect(compactionCall!.options?.includeInternalMessages).toBe(true)
    const messages = compactionCall!.messages

    // 找到压缩指令 user 消息
    const compactionUserIdx = messages.findIndex(
      m => m.role === 'user' && extractTextFromContent(m.content).includes('请对上面的对话历史')
    )
    expect(compactionUserIdx).toBeGreaterThan(-1)

    // 压缩指令前面不应是另一条 user 消息
    if (compactionUserIdx > 0) {
      expect(messages[compactionUserIdx - 1].role).not.toBe('user')
    }
  })

  it('restoreCompactedContext 用快照恢复压缩态上下文', () => {
    const { loop } = createLoop()
    const recentMessages: ChatMessage[] = [
      { role: 'user', content: '最近用户问题' },
      { role: 'assistant', content: '最近助手回复' }
    ]

    loop.restoreCompactedContext('测试摘要内容', recentMessages, 2)

    const ctx = loop.getContext()
    expect(ctx[0].role).toBe('system')
    expect(extractTextFromContent(ctx[0].content)).toContain('测试摘要内容')
    expect(ctx.slice(1)).toEqual(recentMessages)
    // 压缩层级与冷却计数应被快照恢复
    expect((loop as unknown as { compactionLevel: number }).compactionLevel).toBe(2)
    expect((loop as unknown as { userTurnsSinceCompaction: number }).userTurnsSinceCompaction).toBe(0)
  })

  it('Layer 1 紧急压缩成功并重试', async () => {
    const client = new MockModelClient()
    // 1. 第一轮 chat 返回溢出错误
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'context_overflow', rawError: 'context length exceeded' }
      ]
    })
    // 2. 压缩摘要调用返回成功
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'text_delta', delta: '这是紧急摘要。' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })
    // 3. 压缩后重试正常回复
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'text_delta', delta: '终于回复成功了。' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })

    const { loop, eventBus } = createLoop(client)
    const events: any[] = []
    eventBus.on(e => events.push(e))

    // 注入足够多的历史（超过 MIN_RECENT_MESSAGES = 20），以进行紧急压缩
    const history: ChatMessage[] = []
    for (let i = 0; i < 12; i++) {
      history.push(
        { role: 'user', content: `q${i}` },
        { role: 'assistant', content: `a${i}` }
      )
    }
    loop.injectHistory(history)

    await loop.sendMessage('问题2')

    // 检查最终状态是 idle
    expect(loop.getState()).toBe('idle')
    // 并且 events 中没有抛出 error 事件
    expect(events.some(e => e.type === 'error')).toBe(false)
    // 最终回复合并了摘要
    const lastMsg = loop.getContext()[loop.getContext().length - 1]
    expect(lastMsg.role).toBe('assistant')
    expect(lastMsg.content).toBe('终于回复成功了。')
    // 并且第一条 system 消息里带有了摘要
    expect(loop.getContext()[0].content).toContain('这是紧急摘要。')
  })

  it('Layer 1 压缩本身溢出后，升级到 Layer 2 压缩成功并重试', async () => {
    const client = new MockModelClient()
    // 1. 第一轮 chat 溢出
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'context_overflow', rawError: 'context length exceeded' }
      ]
    })
    // 2. Layer 1 压缩调用本身又溢出
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'context_overflow', rawError: 'compaction input too long' }
      ]
    })
    // 3. Layer 2 压缩调用成功返回摘要
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'text_delta', delta: '更深层次的摘要。' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })
    // 4. 重试正常回复
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'text_delta', delta: '回复成功。' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })

    const { loop } = createLoop(client)

    // 注入多条历史消息，使 Layer 2 弹起后依然有消息可以被压缩（至少 44 条非系统消息）
    const history: ChatMessage[] = []
    for (let i = 0; i < 22; i++) {
      history.push(
        { role: 'user', content: `q${i}` },
        { role: 'assistant', content: `a${i}` }
      )
    }
    loop.injectHistory(history)

    await loop.sendMessage('最终问题')

    expect(loop.getState()).toBe('idle')
    expect(loop.getContext()[0].content).toContain('更深层次的摘要。')
    const lastMsg = loop.getContext()[loop.getContext().length - 1]
    expect(lastMsg.role).toBe('assistant')
    expect(lastMsg.content).toBe('回复成功。')
  })

  it('Layer 1 和 Layer 2 均失败时，向上抛出错误，且上下文恢复原样', async () => {
    const client = new MockModelClient()
    // 1. 第一轮 chat 溢出
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'context_overflow', rawError: 'context length exceeded' }
      ]
    })
    // 2. Layer 1 压缩失败
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'error', error: 'API Error' }
      ]
    })
    // 3. Layer 2 压缩失败
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'error', error: 'API Error' }
      ]
    })

    const { loop } = createLoop(client)

    await loop.sendMessage('触发溢出问题')

    // 状态为 error
    expect(loop.getState()).toBe('error')

    // 发送消息失败后，由于回滚，发送的消息和被弹出的消息均会恢复
    const lastMsg = loop.getContext()[loop.getContext().length - 1]
    expect(lastMsg.role).toBe('user')
    expect(lastMsg.content).toContain('触发溢出问题')
  })

  it('当没有足够多的历史消息可压缩时（oldMessages为空），紧急压缩应早退且不丢失消息', async () => {
    const client = new MockModelClient()
    // 1. 第一轮 chat 溢出
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'context_overflow', rawError: 'context length exceeded' }
      ]
    })

    const { loop } = createLoop(client)

    // 不注入历史（非系统消息只有 sendMessage 发出的 1 条，它会被弹起，弹起后剩余 0 条，触发 oldMessages 为空 early return）
    await loop.sendMessage('单独一条消息')

    // 应该因为无可压缩消息且 chat 报错而进入 error 状态
    expect(loop.getState()).toBe('error')

    // 关键断言：弹起的消息应该被正确推回 context，不能丢失
    const lastMsg = loop.getContext()[loop.getContext().length - 1]
    expect(lastMsg.role).toBe('user')
    expect(lastMsg.content).toContain('单独一条消息')
  })

  /**
   * 回归：对「完全相同的工具调用」反复失败时应触发熔断，
   * 在达到 REPEATED_FAILURE_LIMIT(3) 次失败后停止本轮循环，
   * 而不是空转烧满 maxToolRounds 并向渲染进程灌入海量事件（卡顿 / OOM 根因之一）。
   */
  it('同一工具调用连续失败达上限时熔断，停止继续调用模型', async () => {
    const client = new MockModelClient()
    // 模型每一轮都用「完全相同的参数」调用 badedit 工具（模拟死循环）
    for (let i = 0; i < 6; i++) {
      client.addResponse({
        events: [
          { type: 'message_start' },
          {
            type: 'tool_call',
            toolCall: { id: `call_${i}`, name: 'badedit', arguments: '{"filePath":"x.ts"}' }
          },
          { type: 'message_end', finishReason: 'tool_calls' }
        ]
      })
    }

    const registry = new ToolRegistry()
    registry.register({
      name: 'badedit',
      description: '总是失败的工具',
      parameters: { type: 'object', properties: { filePath: { type: 'string' } } },
      async execute(): Promise<ToolResult> {
        return { success: false, output: '', error: 'File has not been read yet.' }
      }
    })

    const eventBus = new EventBus()
    const loop = new AgentLoop(client, eventBus)
    loop.setToolRegistry(registry)

    const events: any[] = []
    eventBus.on((e) => events.push(e))

    await loop.sendMessage('反复触发同一失败调用')

    // 第 3 次失败后熔断：模型只应被调用 3 次（而非 maxToolRounds=20 次）
    expect(client.getCalls()).toHaveLength(3)

    // 应发出包含「已自动中断」的提示文本
    const noticed = events.some(
      (e) => e.type === 'text_delta' && typeof e.delta === 'string' && e.delta.includes('已自动中断')
    )
    expect(noticed).toBe(true)

    // 循环正常收尾（idle），并发出 message_end
    expect(loop.getState()).toBe('idle')
    expect(events.some((e) => e.type === 'message_end')).toBe(true)
  })

  /**
   * 回归：熔断基于结构化 failed 标记，能覆盖"未注册工具"这类
   * 错误结果不以"工具执行失败"开头的失败（旧的字符串前缀匹配会漏判）。
   */
  it('反复调用未注册工具同样触发熔断', async () => {
    const client = new MockModelClient()
    for (let i = 0; i < 6; i++) {
      client.addResponse({
        events: [
          { type: 'message_start' },
          {
            type: 'tool_call',
            toolCall: { id: `call_${i}`, name: 'ghost_tool', arguments: '{"x":1}' }
          },
          { type: 'message_end', finishReason: 'tool_calls' }
        ]
      })
    }

    // 只注册 ls，ghost_tool 不存在 → 每轮返回"工具不可用"错误（failed: true）
    const { loop, eventBus } = createLoop(client)

    const events: any[] = []
    eventBus.on((e) => events.push(e))

    await loop.sendMessage('反复调用不存在的工具')

    // 第 3 次失败后熔断：模型只应被调用 3 次
    expect(client.getCalls()).toHaveLength(3)
    const noticed = events.some(
      (e) => e.type === 'text_delta' && typeof e.delta === 'string' && e.delta.includes('已自动中断')
    )
    expect(noticed).toBe(true)
  })

  /**
   * 配套验证：参数每次都不同（模型在迭代修复）时不应被熔断误伤。
   */
  it('参数每轮不同的失败调用不会触发熔断', async () => {
    const client = new MockModelClient()
    for (let i = 0; i < 5; i++) {
      client.addResponse({
        events: [
          { type: 'message_start' },
          {
            type: 'tool_call',
            toolCall: { id: `call_${i}`, name: 'badedit', arguments: `{"filePath":"x${i}.ts"}` }
          },
          { type: 'message_end', finishReason: 'tool_calls' }
        ]
      })
    }
    // 第 5 轮后给一个正常结束，避免依赖 maxToolRounds 行为
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'text_delta', delta: '完成' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })

    const registry = new ToolRegistry()
    registry.register({
      name: 'badedit',
      description: '总是失败的工具',
      parameters: { type: 'object', properties: { filePath: { type: 'string' } } },
      async execute(): Promise<ToolResult> {
        return { success: false, output: '', error: 'File has not been read yet.' }
      }
    })

    const eventBus = new EventBus()
    const loop = new AgentLoop(client, eventBus)
    loop.setToolRegistry(registry)

    const events: any[] = []
    eventBus.on((e) => events.push(e))

    await loop.sendMessage('每轮参数不同')

    // 不应熔断：不应出现「已自动中断」提示
    const noticed = events.some(
      (e) => e.type === 'text_delta' && typeof e.delta === 'string' && e.delta.includes('已自动中断')
    )
    expect(noticed).toBe(false)
  })

  /**
   * Phase 3：cancel 后 message_end 事件应携带 interrupted=true。
   */
  it('Phase 3: cancel 后 message_end 事件应携带 interrupted=true', async () => {
    const client = new MockModelClient()
    // 第一个 chunk 后立刻 cancelled
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'text_delta', delta: '一段话' },
        { type: 'cancelled' }
      ]
    })

    const { loop, eventBus } = createLoop(client)
    const events: Array<{ type: string; interrupted?: boolean }> = []
    eventBus.on((e) => events.push(e as { type: string; interrupted?: boolean }))

    await loop.sendMessage('取消我')

    const messageEndEvent = events.find(e => e.type === 'message_end')
    expect(messageEndEvent).toBeDefined()
    expect(messageEndEvent!.interrupted).toBe(true)
  })

  /**
   * Phase 3：正常完成（非 cancel）的 message_end 不应携带 interrupted 字段。
   */
  it('Phase 3: 正常完成的 message_end 不应携带 interrupted', async () => {
    const client = new MockModelClient()
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'text_delta', delta: '正常回复' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })

    const { loop, eventBus } = createLoop(client)
    const events: Array<{ type: string; interrupted?: boolean }> = []
    eventBus.on((e) => events.push(e as { type: string; interrupted?: boolean }))

    await loop.sendMessage('你好')

    const messageEndEvent = events.find(e => e.type === 'message_end')
    expect(messageEndEvent).toBeDefined()
    expect(messageEndEvent!.interrupted).toBeUndefined()
  })

  it('slash inject：上下文含 assistant 技能段与 follow-up user', async () => {
    const skillsDir = join(tmpdir(), `loop-skill-${Date.now()}`)
    mkdirSync(join(skillsDir, 'onboard'), { recursive: true })
    writeFileSync(
      join(skillsDir, 'onboard', 'SKILL.md'),
      `---\nname: onboard\ndescription: guide\n---\nOnboard instructions here.`
    )
    const skillRegistry = SkillRegistry.load({ globalDir: skillsDir })

    const client = new MockModelClient()
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'text_delta', delta: 'ok' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })

    const { loop } = createLoop(client)
    loop.setSkillRegistry(skillRegistry)

    await loop.sendMessage('/onboard')

    const ctx = loop.getContext()
    const assistant = ctx.find(m => m.role === 'assistant' && String(m.content).includes('Onboard instructions'))
    const userFollowUp = ctx.filter(m => m.role === 'user').pop()
    expect(assistant).toBeDefined()
    expect(String(userFollowUp?.content)).toContain('请按上述技能指令执行')

    rmSync(skillsDir, { recursive: true, force: true })
  })

  // ── S1 回归：error / overflow 路径不应启动 idleTimer ────────

  it('S1: 模型 error 后不启动 idleTimer', async () => {
    const startSpy = vi.spyOn(IdleCompressionTimer.prototype, 'start')
    const cancelSpy = vi.spyOn(IdleCompressionTimer.prototype, 'cancel')

    const client = new MockModelClient()
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'error', error: '模拟模型内部错误' }
      ]
    })

    const { loop } = createLoop(client)
    await loop.sendMessage('trigger error')

    // 模型 error 后最终态为 error
    expect(loop.getState()).toBe('error')
    // idleTimer.start 必须未被调用（S1 关键断言）
    expect(startSpy).not.toHaveBeenCalled()

    startSpy.mockRestore()
    cancelSpy.mockRestore()
  })

  it('S1: context_overflow 最终失败后不启动 idleTimer', async () => {
    const startSpy = vi.spyOn(IdleCompressionTimer.prototype, 'start')
    const cancelSpy = vi.spyOn(IdleCompressionTimer.prototype, 'cancel')

    const client = new MockModelClient()
    // 反复触发 context_overflow，让 recovery 走到 failed 路径
    // 第一次：触发 overflow，进入重试
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'context_overflow', rawError: 'context length exceeded' }
      ]
    })
    // 第二次：再 overflow，达到重试上限后 failed
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'context_overflow', rawError: 'context length exceeded' }
      ]
    })
    // 兜底：万一 recovery 仍想重试，再补几条
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'context_overflow', rawError: 'context length exceeded' }
      ]
    })
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'context_overflow', rawError: 'context length exceeded' }
      ]
    })

    const { loop } = createLoop(client)
    await loop.sendMessage('trigger overflow')

    // 无论 recovery 怎么决策，最终态必须是 error（不能是 idle）
    expect(loop.getState()).toBe('error')
    expect(startSpy).not.toHaveBeenCalled()

    startSpy.mockRestore()
    cancelSpy.mockRestore()
  })

  it('S1: 正常完成后仍然启动 idleTimer（基线，防止误改正常路径）', async () => {
    const startSpy = vi.spyOn(IdleCompressionTimer.prototype, 'start')

    const client = new MockModelClient()
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'text_delta', delta: 'done' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })

    const { loop } = createLoop(client)
    await loop.sendMessage('normal flow')

    expect(loop.getState()).toBe('idle')
    expect(startSpy).toHaveBeenCalled()

    startSpy.mockRestore()
  })

  it('sendMessage 后对旧工具组 aging 并降低 token 估算，工具组配对不破坏', async () => {
    const client = new MockModelClient()
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'text_delta', delta: 'ok' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })

    const { loop } = createLoop(client)

    // 预置 35 轮 user+tool 上下文（确保有组落在 MIN_RECENT 保护区外且 user 年龄 > 8）
    const seeded: ChatMessage[] = [{ role: 'system', content: '你是助手。' }]
    for (let u = 0; u < 35; u++) {
      seeded.push({ role: 'user', content: `question ${u}` })
      seeded.push({
        role: 'assistant',
        content: 'tool run',
        toolCalls: [{ id: `tc_${u}`, name: 'bash', arguments: '{}' }]
      })
      seeded.push({
        role: 'tool',
        content: `line1\n${'z'.repeat(AGING_GROUP_BYTES_THRESHOLD + 50)}`,
        toolCallId: `tc_${u}`
      })
    }
    ;(loop as unknown as { context: ChatMessage[] }).context = seeded

    const toolBytesBefore = seeded
      .filter(m => m.role === 'tool')
      .reduce((sum, m) => sum + Buffer.byteLength(extractTextFromContent(m.content), 'utf8'), 0)

    await loop.sendMessage('继续')

    const ctx = loop.getContext()
    const toolBytesAfter = ctx
      .filter(m => m.role === 'tool')
      .reduce((sum, m) => sum + Buffer.byteLength(extractTextFromContent(m.content), 'utf8'), 0)

    expect(toolBytesAfter).toBeLessThan(toolBytesBefore)

    const agedTools = ctx.filter(
      m => m.role === 'tool' && extractTextFromContent(m.content).includes('[aged tool result]')
    )
    expect(agedTools.length).toBeGreaterThan(0)

    // 配对完整：每个 assistant(toolCalls) 后仍有 tool 消息
    const nonSystem = ctx.filter(m => m.role !== 'system')
    for (const msg of nonSystem) {
      if (msg.role === 'assistant' && msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          expect(nonSystem.some(m => m.role === 'tool' && m.toolCallId === tc.id)).toBe(true)
        }
      }
    }
  })

  it('context_overflow 压缩成功但模型持续溢出，第 4 次直接失败', async () => {
    const client = new MockModelClient()

    const addOverflowWithCompaction = () => {
      client.addResponse({
        events: [{ type: 'message_start' }, { type: 'context_overflow', rawError: 'context overflow token limit' }]
      })
      client.addResponse({
        events: [{ type: 'text_delta', delta: '压缩摘要' }, { type: 'message_end', finishReason: 'stop' }]
      })
    }

    addOverflowWithCompaction()
    addOverflowWithCompaction()
    addOverflowWithCompaction()
    // 第 4 次溢出应被重试上限拦截，不再进入压缩
    client.addResponse({
      events: [{ type: 'message_start' }, { type: 'context_overflow', rawError: 'context overflow token limit' }]
    })

    const { loop } = createLoop(client)
    loop.injectHistory(Array.from({ length: 30 }, (_, i) => ({ role: 'user' as const, content: `历史 ${i}` })))

    await loop.sendMessage('hi')
    expect(loop.getState()).toBe('error')
  })
})
