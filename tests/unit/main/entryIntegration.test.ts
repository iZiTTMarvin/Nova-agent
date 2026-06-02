import { describe, it, expect } from 'vitest'
import { AgentLoop } from '../../../src/runtime/agent/AgentLoop'
import { EventBus } from '../../../src/runtime/agent/EventBus'
import { MockModelClient } from '../../../src/test-support/builders/MockModelClient'
import { buildConversationContext } from '../../../src/runtime/agent/contextBuilder'
import { ToolRegistry } from '../../../src/runtime/tools/ToolRegistry'
import type { ToolContext, ToolResult } from '../../../src/runtime/tools/types'
import type { SessionData } from '../../../src/runtime/sessions/types'

/**
 * 入口级集成测试
 *
 * 验证 agentHandler send-message 的核心 wiring：
 * session.load → contextBuilder 恢复历史 → AgentLoop.injectHistory → 模型拿到完整上下文
 *
 * 这些测试模拟 agentHandler 的真实入口行为，而非只测单个类
 */

function makeSession(messages: SessionData['messages']): SessionData {
  return {
    id: 'sess_integration',
    workspaceRoot: '/tmp/project',
    mode: 'default',
    messages,
    createdAt: 1,
    updatedAt: 2
  }
}

function createTestRegistry(): ToolRegistry {
  const registry = new ToolRegistry()
  registry.register({
    name: 'ls',
    description: '列出目录',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } }
    },
    async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
      return { success: true, output: `目录内容: ${args.path ?? '.'}` }
    }
  })
  return registry
}

describe('入口级集成测试：agentHandler wiring', () => {
  it('send-message 入口：session 历史 → contextBuilder → AgentLoop 上下文', async () => {
    // 模拟一个已有两轮对话的 session
    const session = makeSession([
      { id: 'm1', role: 'user', content: '第一轮问题', timestamp: 1 },
      {
        id: 'm2',
        role: 'assistant',
        content: '让我看看目录。',
        toolCalls: [
          { id: 'tc_1', name: 'ls', arguments: '{"path":"."}', result: 'file1.ts\nfile2.ts' }
        ],
        timestamp: 2
      },
      { id: 'm3', role: 'user', content: '第二轮问题', timestamp: 3 },
      { id: 'm4', role: 'assistant', content: '已找到。', timestamp: 4 }
    ])

    // 模拟 agentHandler 的真实流程：
    // 1. buildConversationContext
    const history = buildConversationContext(session, 'default')

    // 2. 创建 AgentLoop 并注入历史
    const client = new MockModelClient()
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'text_delta', delta: '基于上文回复...' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })

    const eventBus = new EventBus()
    const loop = new AgentLoop(client, eventBus, {
      systemPrompt: '你是 Nova 的编程助手。'
    })
    loop.setToolRegistry(createTestRegistry())
    loop.injectHistory(history)

    // 3. 发送第三轮消息
    await loop.sendMessage('第三轮问题')

    // 4. 验证模型拿到了完整上下文
    const calls = client.getCalls()
    expect(calls).toHaveLength(1)
    const modelMessages = calls[0].messages

    // system prompt + 第一轮历史 + 第二轮历史 + 第三轮用户消息
    expect(modelMessages[0].role).toBe('system')
    expect(modelMessages[1]).toEqual({ role: 'user', content: '第一轮问题' })
    expect(modelMessages[2]).toEqual({
      role: 'assistant',
      content: '让我看看目录。',
      toolCalls: [{ id: 'tc_1', name: 'ls', arguments: '{"path":"."}' }]
    })
    expect(modelMessages[3]).toEqual({ role: 'tool', content: 'file1.ts\nfile2.ts', toolCallId: 'tc_1' })
    expect(modelMessages[4]).toEqual({ role: 'user', content: '第二轮问题' })
    expect(modelMessages[5]).toEqual({ role: 'assistant', content: '已找到。' })
    expect(modelMessages[6].role).toBe('user')
    expect(modelMessages[6].content).toContain('第三轮问题')

    // 总共 7 条消息
    expect(modelMessages).toHaveLength(7)
  })

  it('空 session 发送第一轮消息时，模型只拿到 system prompt + user message', async () => {
    const session = makeSession([])

    const history = buildConversationContext(session, 'default')

    const client = new MockModelClient()
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })

    const eventBus = new EventBus()
    const loop = new AgentLoop(client, eventBus, { systemPrompt: '助手' })
    loop.injectHistory(history)

    await loop.sendMessage('你好')

    const calls = client.getCalls()
    expect(calls[0].messages[0]).toEqual({ role: 'system', content: '助手' })
    expect(calls[0].messages[1].role).toBe('user')
    expect(calls[0].messages[1].content).toContain('你好')
  })

  it('thinking 块不在模型上下文中出现', async () => {
    const session = makeSession([
      { id: 'm1', role: 'user', content: '分析代码', timestamp: 1 },
      {
        id: 'm2',
        role: 'assistant',
        content: '分析结果...',
        blocks: [
          { type: 'thinking', content: '内部推理不应该发给模型' },
          { type: 'text', content: '分析结果...' }
        ],
        timestamp: 2
      }
    ])

    const history = buildConversationContext(session, 'default')

    const client = new MockModelClient()
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })

    const eventBus = new EventBus()
    const loop = new AgentLoop(client, eventBus, { systemPrompt: '助手' })
    loop.injectHistory(history)
    await loop.sendMessage('继续分析')

    const modelMessages = client.getCalls()[0].messages
    // 不应出现 thinking 内容
    const allContent = modelMessages.map(m => m.content).join(' ')
    expect(allContent).not.toContain('内部推理不应该发给模型')

    // assistant 消息应只包含纯正文
    const assistantMsg = modelMessages.find(m => m.role === 'assistant')
    expect(assistantMsg?.content).toBe('分析结果...')
  })

  it('连续多轮工具调用后，模型能感知完整历史链', async () => {
    const session = makeSession([
      { id: 'm1', role: 'user', content: '看目录', timestamp: 1 },
      {
        id: 'm2', role: 'assistant', content: '',
        toolCalls: [
          { id: 'tc_1', name: 'ls', arguments: '{"path":"."}', result: 'src/\ntests/' }
        ],
        timestamp: 2
      },
      { id: 'm3', role: 'user', content: '读 src/index.ts', timestamp: 3 },
      {
        id: 'm4', role: 'assistant', content: '',
        toolCalls: [
          { id: 'tc_2', name: 'read', arguments: '{"path":"src/index.ts"}', result: 'export {}' }
        ],
        timestamp: 4
      },
      { id: 'm5', role: 'user', content: '文件是空的，加个函数', timestamp: 5 },
      {
        id: 'm6', role: 'assistant', content: '已添加。', timestamp: 6
      }
    ])

    const history = buildConversationContext(session, 'default')

    const client = new MockModelClient()
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'text_delta', delta: '好的' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })

    const eventBus = new EventBus()
    const loop = new AgentLoop(client, eventBus, { systemPrompt: '助手' })
    loop.injectHistory(history)
    await loop.sendMessage('再加一个')

    const modelMessages = client.getCalls()[0].messages

    // 应该有完整的 3 轮历史 + 本轮 user
    const userMsgs = modelMessages.filter(m => m.role === 'user')
    expect(userMsgs).toHaveLength(4)

    const toolMsgs = modelMessages.filter(m => m.role === 'tool')
    expect(toolMsgs).toHaveLength(2)
    expect(toolMsgs[0].toolCallId).toBe('tc_1')
    expect(toolMsgs[1].toolCallId).toBe('tc_2')
  })
})
