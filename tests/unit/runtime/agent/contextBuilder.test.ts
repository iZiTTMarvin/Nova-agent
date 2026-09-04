import { describe, it, expect } from 'vitest'
import { buildConversationContext } from '../../../../src/runtime/sessions'
import type { SessionData } from '../../../../src/runtime/sessions/types'

/** 构造最小化 SessionData，只填充 messages */
function makeSession(messages: SessionData['messages']): SessionData {
  return {
    schemaVersion: 2,
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
      { role: 'user', content: '你好', origin: { messageId: 'm1', step: 0 } },
      { role: 'assistant', content: '你好！有什么可以帮你的？', origin: { messageId: 'm2', step: 0 } }
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
      { role: 'user', content: '列出目录', origin: { messageId: 'm1', step: 0 } },
      {
        role: 'assistant',
        content: '让我看看目录结构...',
        toolCalls: [{ id: 'tc_1', name: 'ls', arguments: '{"path":"."}' }],
        origin: { messageId: 'm2', step: 0 }
      },
      { role: 'tool', content: 'file1.ts\nfile2.ts', toolCallId: 'tc_1', origin: { messageId: 'm2', step: 0 } }
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
    expect(result[0]).toEqual({ role: 'user', content: '读两个文件', origin: { messageId: 'm1', step: 0 } })
    expect(result[1]).toEqual({
      role: 'assistant',
      content: '',
      toolCalls: [
        { id: 'tc_1', name: 'read', arguments: '{"path":"a.ts"}' },
        { id: 'tc_2', name: 'read', arguments: '{"path":"b.ts"}' }
      ],
      origin: { messageId: 'm2', step: 0 }
    })
    expect(result[2]).toEqual({
      role: 'tool',
      content: 'content a',
      toolCallId: 'tc_1',
      origin: { messageId: 'm2', step: 0 }
    })
    expect(result[3]).toEqual({
      role: 'tool',
      content: 'content b',
      toolCallId: 'tc_2',
      origin: { messageId: 'm2', step: 0 }
    })
  })

  it('恢复带 artifactId 的工具结果', () => {
    const session = makeSession([
      { id: 'm1', role: 'user', content: '跑命令', timestamp: 1 },
      {
        id: 'm2',
        role: 'assistant',
        content: '',
        toolCalls: [{
          id: 'tc_bash',
          name: 'bash',
          arguments: '{"command":"echo hi"}',
          result: 'tail\nartifact://abc123',
          artifactId: 'abc123',
          truncationMeta: { totalBytes: 10000, totalLines: 200, shownLines: 20, truncated: true }
        }],
        timestamp: 2
      }
    ])

    const result = buildConversationContext(session, 'default')
    const toolMsg = result.find(m => m.role === 'tool')
    expect(toolMsg).toEqual({
      role: 'tool',
      content: 'tail\nartifact://abc123',
      toolCallId: 'tc_bash',
      artifactId: 'abc123',
      truncationMeta: { totalBytes: 10000, totalLines: 200, shownLines: 20, truncated: true },
      origin: { messageId: 'm2', step: 0 }
    })
  })

  it('cancel 后仅持久化消息进入上下文，artifactId 仍可被 read artifact:// 引用', () => {
    const session = makeSession([
      {
        id: 'm1',
        role: 'assistant',
        content: 'interrupted reply',
        interrupted: true,
        toolCalls: [{
          id: 'tc_grep',
          name: 'grep',
          arguments: '{"pattern":"x"}',
          result: 'shown lines\nartifact://grep_art_id',
          artifactId: 'grep_art_id',
          truncationMeta: { totalBytes: 50000, totalLines: 600, shownLines: 100, truncated: true }
        }],
        timestamp: 1
      }
    ])

    const context = buildConversationContext(session, 'default')
    // 无 cancel 残留的 user/assistant 中间态，只有已保存的一条 assistant + tool
    expect(context.filter(m => m.role === 'user')).toHaveLength(0)
    expect(context.filter(m => m.role === 'assistant')).toHaveLength(1)
    const toolMsg = context.find(m => m.role === 'tool')
    expect(toolMsg?.artifactId).toBe('grep_art_id')
    expect(toolMsg?.content).toContain('artifact://grep_art_id')
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
      { role: 'user', content: '分析项目', origin: { messageId: 'm1', step: 0 } },
      { role: 'assistant', content: '分析如下...', origin: { messageId: 'm2', step: 0 } }
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
      { role: 'user', content: '看目录', origin: { messageId: 'm1', step: 0 } },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'tc_1', name: 'ls', arguments: '{"path":"."}' }],
        origin: { messageId: 'm2', step: 0 }
      },
      { role: 'tool', content: 'file1.ts', toolCallId: 'tc_1', origin: { messageId: 'm2', step: 0 } },
      { role: 'user', content: '读 file1.ts', origin: { messageId: 'm3', step: 0 } },
      { role: 'assistant', content: '文件内容如下...', origin: { messageId: 'm4', step: 0 } }
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
      { role: 'user', content: '你好', origin: { messageId: 'm1', step: 0 } },
      { role: 'assistant', content: '你好！', origin: { messageId: 'm2', step: 0 } }
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
      { role: 'user', content: '看看', origin: { messageId: 'm1', step: 0 } },
      { role: 'assistant', content: '', origin: { messageId: 'm2', step: 0 } },
      { role: 'tool', content: 'some result', toolCallId: 'tc_1', origin: { messageId: 'm3', step: 0 } },
      { role: 'assistant', content: '结果如下', origin: { messageId: 'm4', step: 0 } }
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
      toolCallId: 'tc_1',
      origin: { messageId: 'm1', step: 0 }
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
        { role: 'user', content: 'q1', origin: { messageId: 'm1', step: 0 } },
        { role: 'assistant', content: 'a1', origin: { messageId: 'm2', step: 0 } }
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

  describe('DSML 泄漏正文清洗', () => {
    const FULLWIDTH_PIPE = '\uFF5C'
    const dsmlBlock =
      `<${FULLWIDTH_PIPE}DSML${FULLWIDTH_PIPE}tool_calls>` +
      `<${FULLWIDTH_PIPE}DSML${FULLWIDTH_PIPE}invoke name="grep">` +
      `<${FULLWIDTH_PIPE}DSML${FULLWIDTH_PIPE}parameter name="pattern">classScore` +
      `</${FULLWIDTH_PIPE}DSML${FULLWIDTH_PIPE}parameter>` +
      `</${FULLWIDTH_PIPE}DSML${FULLWIDTH_PIPE}invoke>` +
      `</${FULLWIDTH_PIPE}DSML${FULLWIDTH_PIPE}tool_calls>`

    it('assistant 正文中的 DSML 标记被剥离', () => {
      const session = makeSession([
        {
          id: 'm1',
          role: 'assistant',
          content: `我先搜索一下。\n${dsmlBlock}`,
          timestamp: 1
        }
      ])

      const result = buildConversationContext(session, 'default')
      expect(result[0].role).toBe('assistant')
      expect(result[0].content).toBe('我先搜索一下。')
      expect(String(result[0].content)).not.toContain('DSML')
    })

    it('普通代码比较表达式不被破坏', () => {
      const code = 'if (a < b && c > d) { return true }'
      const session = makeSession([
        { id: 'm1', role: 'assistant', content: code, timestamp: 1 }
      ])

      const result = buildConversationContext(session, 'default')
      expect(result[0].content).toBe(code)
    })
  })

  describe('档案坐标 origin', () => {
    it('有 blocks 时 origin.step 等于工具组序号，收尾 assistant 用当时的 step', () => {
      const session = makeSession([
        { id: 'u1', role: 'user', content: '修两处', timestamp: 1 },
        {
          id: 'a1',
          role: 'assistant',
          content: '完成',
          blocks: [
            { type: 'text', content: '先读' },
            {
              type: 'tool',
              toolCallId: 'tc_a',
              toolName: 'read',
              arguments: { path: 'a.ts' },
              status: 'success',
              result: 'a'
            },
            { type: 'text', content: '再改' },
            {
              type: 'tool',
              toolCallId: 'tc_b',
              toolName: 'edit',
              arguments: { path: 'b.ts' },
              status: 'success',
              result: 'b'
            },
            { type: 'text', content: '完成' }
          ],
          timestamp: 2
        }
      ])

      const result = buildConversationContext(session, 'default')
      expect(result.map(m => m.origin)).toEqual([
        { messageId: 'u1', step: 0 },
        { messageId: 'a1', step: 0 },
        { messageId: 'a1', step: 0 },
        { messageId: 'a1', step: 1 },
        { messageId: 'a1', step: 1 },
        { messageId: 'a1', step: 2 }
      ])
    })

    it('沿激活路径单调：messageId 跟随路径，同消息内 step 不回退，旁路分支不出现', () => {
      const session: SessionData = {
        ...makeSession([
          { id: 'u1', role: 'user', content: 'q1', timestamp: 1, parentId: null },
          {
            id: 'a1',
            role: 'assistant',
            content: 'a1',
            timestamp: 2,
            parentId: 'u1',
            blocks: [
              {
                type: 'tool',
                toolCallId: 'tc_1',
                toolName: 'ls',
                arguments: {},
                status: 'success',
                result: 'files'
              },
              { type: 'text', content: '看完了' }
            ]
          },
          { id: 'u-side', role: 'user', content: '旁路', timestamp: 3, parentId: 'a1' },
          { id: 'u2', role: 'user', content: 'q2', timestamp: 4, parentId: 'a1' },
          { id: 'a2', role: 'assistant', content: 'done', timestamp: 5, parentId: 'u2' }
        ]),
        currentLeafId: 'a2'
      }

      const result = buildConversationContext(session, 'default')
      expect(result.map(m => `${m.origin?.messageId}:${m.origin?.step}`)).toEqual([
        'u1:0',
        'a1:0',
        'a1:0',
        'a1:1',
        'u2:0',
        'a2:0'
      ])
      expect(result.some(m => m.origin?.messageId === 'u-side')).toBe(false)
    })

    it('from 从指定 step 切片，同一 assistant 后半段仍保留', () => {
      const session: SessionData = {
        ...makeSession([
          { id: 'u1', role: 'user', content: 'q', timestamp: 1, parentId: null },
          {
            id: 'a1',
            role: 'assistant',
            content: 'done',
            timestamp: 2,
            parentId: 'u1',
            blocks: [
              {
                type: 'tool',
                toolCallId: 'tc_1',
                toolName: 'ls',
                arguments: {},
                status: 'success',
                result: 'files'
              },
              { type: 'text', content: '看完了' }
            ]
          }
        ]),
        currentLeafId: 'a1'
      }
      const fromStep1 = buildConversationContext(session, 'default', {
        from: { messageId: 'a1', step: 1 }
      })
      expect(fromStep1.map(m => `${m.origin?.messageId}:${m.origin?.step}`)).toEqual(['a1:1'])
      expect(fromStep1[0]?.content).toBe('看完了')

      const missing = buildConversationContext(session, 'default', {
        from: { messageId: 'missing', step: 0 }
      })
      expect(missing).toEqual([])
    })
  })
})
