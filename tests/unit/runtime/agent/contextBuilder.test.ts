import { describe, it, expect } from 'vitest'
import { buildConversationContext } from '../../../../src/runtime/agent/contextBuilder'
import type { SessionData } from '../../../../src/runtime/sessions/types'

/** 构造最小化 SessionData，只填充 messages */
function makeSession(messages: SessionData['messages']): SessionData {
  return {
    id: 'sess_test',
    workspaceRoot: '/tmp/project',
    mode: 'default',
    messages,
    createdAt: 1,
    updatedAt: 2
  }
}

describe('buildConversationContext', () => {
  it('空会话返回空数组', () => {
    const session = makeSession([])
    const result = buildConversationContext(session, 'default')
    expect(result).toEqual([])
  })

  it('恢复 user 和 assistant 纯文本对话', () => {
    const session = makeSession([
      { id: 'm1', role: 'user', content: '你好', timestamp: 1 },
      { id: 'm2', role: 'assistant', content: '你好！有什么可以帮你的？', timestamp: 2 }
    ])

    const result = buildConversationContext(session, 'default')

    expect(result).toEqual([
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '你好！有什么可以帮你的？' }
    ])
  })

  it('恢复带工具调用的 assistant 消息和对应的 tool 结果', () => {
    const session = makeSession([
      { id: 'm1', role: 'user', content: '列出目录', timestamp: 1 },
      {
        id: 'm2',
        role: 'assistant',
        content: '让我看看目录结构...',
        toolCalls: [
          { id: 'tc_1', name: 'ls', arguments: '{"path":"."}', result: 'file1.ts\nfile2.ts' }
        ],
        timestamp: 2
      }
    ])

    const result = buildConversationContext(session, 'default')

    // assistant 消息带 tool_calls，后面紧跟 tool 结果消息
    expect(result).toEqual([
      { role: 'user', content: '列出目录' },
      {
        role: 'assistant',
        content: '让我看看目录结构...',
        toolCalls: [{ id: 'tc_1', name: 'ls', arguments: '{"path":"."}' }]
      },
      { role: 'tool', content: 'file1.ts\nfile2.ts', toolCallId: 'tc_1' }
    ])
  })

  it('多条工具调用的 assistant 消息恢复为 assistant + 多条 tool 消息', () => {
    const session = makeSession([
      { id: 'm1', role: 'user', content: '读两个文件', timestamp: 1 },
      {
        id: 'm2',
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'tc_1', name: 'read', arguments: '{"path":"a.ts"}', result: 'content a' },
          { id: 'tc_2', name: 'read', arguments: '{"path":"b.ts"}', result: 'content b' }
        ],
        timestamp: 2
      }
    ])

    const result = buildConversationContext(session, 'default')

    expect(result).toHaveLength(4)
    expect(result[0]).toEqual({ role: 'user', content: '读两个文件' })
    expect(result[1]).toEqual({
      role: 'assistant',
      content: '',
      toolCalls: [
        { id: 'tc_1', name: 'read', arguments: '{"path":"a.ts"}' },
        { id: 'tc_2', name: 'read', arguments: '{"path":"b.ts"}' }
      ]
    })
    expect(result[2]).toEqual({ role: 'tool', content: 'content a', toolCallId: 'tc_1' })
    expect(result[3]).toEqual({ role: 'tool', content: 'content b', toolCallId: 'tc_2' })
  })

  it('thinking 块不进入模型上下文', () => {
    const session = makeSession([
      { id: 'm1', role: 'user', content: '分析项目', timestamp: 1 },
      {
        id: 'm2',
        role: 'assistant',
        content: '分析如下...',
        blocks: [
          { type: 'thinking', content: '内部推理过程...' },
          { type: 'text', content: '分析如下...' }
        ],
        timestamp: 2
      }
    ])

    const result = buildConversationContext(session, 'default')

    // 只应有 user + assistant（纯正文），不应包含 thinking
    expect(result).toEqual([
      { role: 'user', content: '分析项目' },
      { role: 'assistant', content: '分析如下...' }
    ])
  })

  it('多轮对话完整恢复：user → assistant(tool) → tool → user → assistant', () => {
    const session = makeSession([
      { id: 'm1', role: 'user', content: '看目录', timestamp: 1 },
      {
        id: 'm2',
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'tc_1', name: 'ls', arguments: '{"path":"."}', result: 'file1.ts' }
        ],
        timestamp: 2
      },
      { id: 'm3', role: 'user', content: '读 file1.ts', timestamp: 3 },
      {
        id: 'm4',
        role: 'assistant',
        content: '文件内容如下...',
        timestamp: 4
      }
    ])

    const result = buildConversationContext(session, 'default')

    expect(result).toEqual([
      { role: 'user', content: '看目录' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'tc_1', name: 'ls', arguments: '{"path":"."}' }]
      },
      { role: 'tool', content: 'file1.ts', toolCallId: 'tc_1' },
      { role: 'user', content: '读 file1.ts' },
      { role: 'assistant', content: '文件内容如下...' }
    ])
  })

  it('跳过系统消息（system prompt 由当前 mode 重新生成）', () => {
    const session = makeSession([
      { id: 'm0', role: 'system', content: '旧 system prompt', timestamp: 0 },
      { id: 'm1', role: 'user', content: '你好', timestamp: 1 },
      { id: 'm2', role: 'assistant', content: '你好！', timestamp: 2 }
    ])

    const result = buildConversationContext(session, 'default')

    // system 消息被跳过，只有 user + assistant
    expect(result).toEqual([
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '你好！' }
    ])
  })

  it('tool 消息在 session 中独立存在时也能恢复', () => {
    // 正常情况下 tool 消息不会独立存在于 session 中（它们是通过 assistant.toolCalls.result 记录的），
    // 但为健壮性，独立的 tool 消息也应被正确恢复
    const session = makeSession([
      { id: 'm1', role: 'user', content: '看看', timestamp: 1 },
      { id: 'm2', role: 'assistant', content: '', timestamp: 2 },
      { id: 'm3', role: 'tool', content: 'some result', toolCallId: 'tc_1', timestamp: 3 },
      { id: 'm4', role: 'assistant', content: '结果如下', timestamp: 4 }
    ])

    const result = buildConversationContext(session, 'default')

    expect(result).toEqual([
      { role: 'user', content: '看看' },
      { role: 'assistant', content: '' },
      { role: 'tool', content: 'some result', toolCallId: 'tc_1' },
      { role: 'assistant', content: '结果如下' }
    ])
  })

  it('assistant 消息的 toolCalls 只保留 id/name/arguments，不保留 result', () => {
    const session = makeSession([
      {
        id: 'm1',
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'tc_1', name: 'ls', arguments: '{"path":"."}', result: 'file1.ts' }
        ],
        timestamp: 1
      }
    ])

    const result = buildConversationContext(session, 'default')

    // toolCalls 中不应有 result 字段
    const assistantMsg = result.find(m => m.role === 'assistant')!
    expect(assistantMsg.toolCalls![0]).toEqual({
      id: 'tc_1',
      name: 'ls',
      arguments: '{"path":"."}'
    })
    // result 作为独立的 tool 消息存在
    expect(result.find(m => m.role === 'tool')).toEqual({
      role: 'tool',
      content: 'file1.ts',
      toolCallId: 'tc_1'
    })
  })

  describe('session context 与 contextBuilder 的关系（v2 合并方案）', () => {
    it('contextBuilder 不需要处理 session context：它不作为独立消息进 SessionStore', () => {
      // v2 合并方案：session context 拼在 user content 前缀（运行时），不落盘。
      // SessionMessage 类型不携带 internal 字段，contextBuilder 路径根本不会遇到它。
      // 因此 contextBuilder 无须任何 special-case 过滤——它只做 system 跳过 + tool 结果恢复。
      const session = makeSession([
        { id: 'm1', role: 'user', content: 'q1', timestamp: 1 },
        { id: 'm2', role: 'assistant', content: 'a1', timestamp: 2 }
      ])

      const result = buildConversationContext(session, 'default')
      expect(result).toEqual([
        { role: 'user', content: 'q1' },
        { role: 'assistant', content: 'a1' }
      ])
    })

    it('持久化的 user content 不含 session context 前缀（验证不落盘）', () => {
      // 即便运行时 user 消息 content 含 [Session context] 前缀，
      // SessionStore 中保存的是原始用户输入（agentHandler 用 persistContent，
      // 早于 sendMessage）。contextBuilder 从 SessionStore 恢复时只看到原始输入。
      const session = makeSession([
        { id: 'm1', role: 'user', content: '帮我看看 src 目录', timestamp: 1 }
      ])

      const result = buildConversationContext(session, 'default')
      // 恢复出的 user 消息是原始输入，不含 session context 前缀
      expect(result[0].content).toBe('帮我看看 src 目录')
      expect(typeof result[0].content === 'string' &&
        result[0].content.includes('[Session context')).toBe(false)
    })
  })
})
