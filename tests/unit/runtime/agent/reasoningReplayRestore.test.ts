/**
 * T2-2：deepseek/kimi provider-aware 历史恢复投影
 *
 * - deepseek/kimi：按 blocks 拆出正确多子轮 + reasoningContent
 * - generic/glm/minimax：保持 T0-2 扁平断言不变
 * - 不改 session schema / UI blocks / messageProjection
 */
import { describe, expect, it } from 'vitest'
import { AgentLoop } from '../../../../src/runtime/agent/AgentLoop'
import { EventBus } from '../../../../src/runtime/agent/EventBus'
import {
  buildConversationContext,
  projectAssistantWithReasoningReplay
} from '../../../../src/runtime/agent/context/contextBuilder'
import { stripReasoningContent, rebuildWithCompression } from '../../../../src/runtime/agent/compaction/compaction'
import { MockModelClient } from '../../../../src/test-support/builders/MockModelClient'
import { restoreOrInjectHistory, buildSnapshotFromCompaction } from '../../../../src/runtime/sessions/contextSnapshot'
import type { SessionData, SessionMessage } from '../../../../src/runtime/sessions/types'
import type { ChatMessage } from '../../../../src/runtime/model/types'
import type { MessageBlock } from '../../../../src/shared/session'

const TURN_BLOCKS: MessageBlock[] = [
  { type: 'thinking', content: '先读 a.ts 确认问题根因…' },
  {
    type: 'tool',
    toolCallId: 'tc_a',
    toolName: 'read',
    arguments: { path: 'a.ts' },
    status: 'success',
    result: 'content of a.ts'
  },
  { type: 'thinking', content: '再改 b.ts 对齐接口…' },
  {
    type: 'tool',
    toolCallId: 'tc_b',
    toolName: 'edit',
    arguments: { path: 'b.ts', old: 'x', new: 'y' },
    status: 'success',
    result: 'edited b.ts'
  },
  { type: 'text', content: '已完成两处修复。' }
]

/** deepseek：仅 tool 子轮带 reasoning；终态无 tool 不带 */
const DEEPSEEK_RECOVERY: ChatMessage[] = [
  { role: 'user', content: '分析并修复两个问题' },
  {
    role: 'assistant',
    content: '',
    reasoningContent: '先读 a.ts 确认问题根因…',
    toolCalls: [{ id: 'tc_a', name: 'read', arguments: '{"path":"a.ts"}' }]
  },
  { role: 'tool', content: 'content of a.ts', toolCallId: 'tc_a' },
  {
    role: 'assistant',
    content: '',
    reasoningContent: '再改 b.ts 对齐接口…',
    toolCalls: [{ id: 'tc_b', name: 'edit', arguments: '{"path":"b.ts","old":"x","new":"y"}' }]
  },
  { role: 'tool', content: 'edited b.ts', toolCallId: 'tc_b' },
  { role: 'assistant', content: '已完成两处修复。' }
]

/** kimi：全部历史 reasoning；本例终态无 thinking，与 deepseek 序列同形 */
const KIMI_RECOVERY: ChatMessage[] = DEEPSEEK_RECOVERY

const FLATTENED_RECOVERY: ChatMessage[] = [
  { role: 'user', content: '分析并修复两个问题' },
  {
    role: 'assistant',
    content: '已完成两处修复。',
    toolCalls: [
      { id: 'tc_a', name: 'read', arguments: '{"path":"a.ts"}' },
      { id: 'tc_b', name: 'edit', arguments: '{"path":"b.ts","old":"x","new":"y"}' }
    ]
  },
  { role: 'tool', content: 'content of a.ts', toolCallId: 'tc_a' },
  { role: 'tool', content: 'edited b.ts', toolCallId: 'tc_b' }
]

function makeSession(messages: SessionData['messages']): SessionData {
  return {
    schemaVersion: 8,
    id: 'sess_t2_2',
    workspaceRoot: '/tmp/project',
    mode: 'default',
    messages,
    createdAt: 1,
    updatedAt: 2
  }
}

function thinkingToolTurnMessages(): SessionData['messages'] {
  return [
    { id: 'u1', role: 'user', parentId: null, content: '分析并修复两个问题', timestamp: 1 },
    {
      id: 'a1',
      role: 'assistant',
      parentId: 'u1',
      content: '已完成两处修复。',
      blocks: TURN_BLOCKS,
      toolCalls: [
        {
          id: 'tc_a',
          name: 'read',
          arguments: '{"path":"a.ts"}',
          result: 'content of a.ts'
        },
        {
          id: 'tc_b',
          name: 'edit',
          arguments: '{"path":"b.ts","old":"x","new":"y"}',
          result: 'edited b.ts'
        }
      ],
      timestamp: 2
    }
  ]
}

describe('T2-2 deepseek/kimi：按 blocks 恢复多子轮 + reasoning', () => {
  it('deepseek profile：thinking→toolA→thinking→toolB→final 恢复为正确子轮序列', () => {
    const session = makeSession(thinkingToolTurnMessages())
    const recovered = buildConversationContext(session, 'default', {
      reasoningReplay: 'tool-call-history'
    })
    expect(recovered).toEqual(DEEPSEEK_RECOVERY)
    expect(recovered.filter(m => m.role === 'assistant')).toHaveLength(3)
    // 终态无 tool_calls → deepseek 不带 reasoning
    const final = recovered.filter(m => m.role === 'assistant').at(-1)!
    expect(final.reasoningContent).toBeUndefined()
    expect(final.content).toBe('已完成两处修复。')
  })

  it('kimi profile：同序列恢复，且保留全部历史 reasoning（含终态若有 thinking）', () => {
    const session = makeSession(thinkingToolTurnMessages())
    const recovered = buildConversationContext(session, 'default', {
      reasoningReplay: 'all-history'
    })
    expect(recovered).toEqual(KIMI_RECOVERY)

    // 终态前若有 thinking，kimi 应保留
    const withFinalThinking: SessionMessage = {
      id: 'a2',
      role: 'assistant',
      parentId: null,
      content: '结论',
      blocks: [
        { type: 'thinking', content: '最后再想一下' },
        { type: 'text', content: '结论' }
      ],
      timestamp: 3
    }
    const projected = projectAssistantWithReasoningReplay(withFinalThinking, 'all-history')
    expect(projected).toEqual([
      { role: 'assistant', content: '结论', reasoningContent: '最后再想一下' }
    ])
    // deepseek 终态无 tool → 剥离 reasoning
    expect(projectAssistantWithReasoningReplay(withFinalThinking, 'tool-call-history')).toEqual([
      { role: 'assistant', content: '结论' }
    ])
  })

  it('对照：reasoningReplay=none/缺省仍走扁平路径', () => {
    const session = makeSession(thinkingToolTurnMessages())
    for (const replay of ['none', undefined] as const) {
      const recovered = buildConversationContext(
        session,
        'default',
        replay ? { reasoningReplay: replay } : undefined
      )
      expect(recovered).toEqual(FLATTENED_RECOVERY)
      expect(JSON.stringify(recovered)).not.toContain('先读 a.ts')
    }
  })

  it('glm all-history：与 kimi 同形恢复多子轮 + reasoning', () => {
    const session = makeSession(thinkingToolTurnMessages())
    const recovered = buildConversationContext(session, 'default', {
      reasoningReplay: 'all-history',
      currentProviderId: 'glm'
    })
    // 无 providerId 的旧块视为兼容，应完整回放
    expect(recovered).toEqual(KIMI_RECOVERY)
  })

  it('跨档案门控：kimi 来源的 thinking 不进入 glm 回放，存档 blocks 仍保留', () => {
    const blocks: MessageBlock[] = [
      { type: 'thinking', content: 'kimi 的思考', providerId: 'kimi' },
      {
        type: 'tool',
        toolCallId: 'tc_1',
        toolName: 'read',
        arguments: { path: 'a.ts' },
        status: 'success',
        result: 'ok'
      },
      { type: 'thinking', content: 'glm 自己的思考', providerId: 'glm' },
      { type: 'text', content: '结论' }
    ]
    const session = makeSession([
      {
        id: 'u1',
        role: 'user',
        parentId: null,
        content: '问',
        timestamp: 1
      },
      {
        id: 'a1',
        role: 'assistant',
        parentId: 'u1',
        content: '结论',
        blocks,
        toolCalls: [
          {
            id: 'tc_1',
            name: 'read',
            arguments: '{"path":"a.ts"}',
            result: 'ok'
          }
        ],
        timestamp: 2
      }
    ])

    const recovered = buildConversationContext(session, 'default', {
      reasoningReplay: 'all-history',
      currentProviderId: 'glm'
    })

    const assistants = recovered.filter(m => m.role === 'assistant')
    expect(assistants[0].reasoningContent).toBeUndefined()
    expect(assistants[1].reasoningContent).toBe('glm 自己的思考')
    expect(assistants[1].reasoningProviderId).toBe('glm')

    // 存档未被删除
    const stored = session.messages.find(m => m.id === 'a1')!
    expect(stored.blocks?.filter(b => b.type === 'thinking')).toHaveLength(2)
  })

  it('Kimi→DeepSeek：跨档案 reasoning 不再无条件回放', () => {
    const projected = projectAssistantWithReasoningReplay(
      {
        id: 'a1',
        role: 'assistant',
        parentId: null,
        content: '',
        blocks: [
          { type: 'thinking', content: 'kimi 思考', providerId: 'kimi' },
          {
            type: 'tool',
            toolCallId: 'tc',
            toolName: 'bash',
            arguments: {},
            status: 'success',
            result: 'done'
          }
        ],
        toolCalls: [{ id: 'tc', name: 'bash', arguments: '{}', result: 'done' }],
        timestamp: 1
      },
      'tool-call-history',
      'deepseek'
    )
    expect(projected[0].reasoningContent).toBeUndefined()
  })

  it('AgentLoop + restoreOrInjectHistory(deepseek) 与 buildConversationContext 一致', () => {
    const session = makeSession(thinkingToolTurnMessages())
    const loop = new AgentLoop(new MockModelClient(), new EventBus(), {
      systemPrompt: '助手'
    })
    restoreOrInjectHistory(loop, session, null, {
      reasoningReplay: 'tool-call-history'
    })
    const nonSystem = loop.getContext().filter(m => m.role !== 'system')
    expect(nonSystem).toEqual(DEEPSEEK_RECOVERY)
  })

  it('context snapshot 命中：deepseek 下 recent 保留 reasoning，delta 正确投影', () => {
    const session = makeSession(thinkingToolTurnMessages())
    session.currentLeafId = 'a1'
    // 快照 recent 模拟压缩后仍带 reasoning 的运行时上下文
    const recentWithReasoning: ChatMessage[] = [
      {
        role: 'assistant',
        content: '',
        reasoningContent: '再改 b.ts 对齐接口…',
        toolCalls: [{ id: 'tc_b', name: 'edit', arguments: '{"path":"b.ts","old":"x","new":"y"}' }]
      },
      { role: 'tool', content: 'edited b.ts', toolCallId: 'tc_b' },
      { role: 'assistant', content: '已完成两处修复。' }
    ]
    const snapshot = buildSnapshotFromCompaction(session, recentWithReasoning, {
      summary: '已完成 a/b 修复',
      compactionLevel: 1,
      trigger: 'threshold'
    })
    expect(snapshot.lastMessageId).toBe('a1')

    // 锚点后追加新 user
    session.messages.push({
      id: 'u2',
      role: 'user',
      parentId: 'a1',
      content: '再确认一下',
      timestamp: 3
    })
    session.currentLeafId = 'u2'

    const loop = new AgentLoop(new MockModelClient(), new EventBus(), {
      systemPrompt: '助手'
    })
    restoreOrInjectHistory(loop, session, snapshot, {
      reasoningReplay: 'tool-call-history'
    })

    const ctx = loop.getContext()
    // 快照命中：system 含摘要（非全量回退）
    const systemText = String(ctx.find(m => m.role === 'system')?.content ?? '')
    expect(systemText).toContain('已完成 a/b 修复')
    // recent 中带 reasoning 的 tool 子轮仍在
    expect(ctx.some(m => m.role === 'assistant' && m.reasoningContent === '再改 b.ts 对齐接口…')).toBe(
      true
    )
    expect(ctx.some(m => m.role === 'user' && m.content === '再确认一下')).toBe(true)
    // 全量历史的第一段 reasoning 不应出现（已被摘要替代）
    expect(JSON.stringify(ctx)).not.toContain('先读 a.ts 确认问题根因')
  })

  it('snapshot 锚点失效：deepseek 全量回退仍正确拆子轮', () => {
    const session = makeSession(thinkingToolTurnMessages())
    const snapshot = buildSnapshotFromCompaction(session, FLATTENED_RECOVERY, {
      summary: '旧摘要',
      compactionLevel: 1,
      trigger: 'threshold'
    })
    snapshot.lastMessageId = 'msg_does_not_exist'

    const loop = new AgentLoop(new MockModelClient(), new EventBus(), {
      systemPrompt: '助手'
    })
    restoreOrInjectHistory(loop, session, snapshot, {
      reasoningReplay: 'tool-call-history'
    })
    expect(loop.getContext().filter(m => m.role !== 'system')).toEqual(DEEPSEEK_RECOVERY)
  })

  it('压缩：stripReasoningContent 剥离摘要请求侧；rebuild 的 recent 保留 reasoning', () => {
    const withReasoning: ChatMessage[] = [
      {
        role: 'assistant',
        content: '',
        reasoningContent: '思考中',
        toolCalls: [{ id: 't1', name: 'read', arguments: '{}' }]
      },
      { role: 'tool', content: 'ok', toolCallId: 't1' }
    ]
    const stripped = stripReasoningContent(withReasoning)
    expect(stripped[0].reasoningContent).toBeUndefined()
    expect(withReasoning[0].reasoningContent).toBe('思考中') // stripReasoningContent 返回新数组，不修改入参

    const rebuilt = rebuildWithCompression('sys', '摘要不含思考', withReasoning)
    expect(rebuilt.find(m => m.role === 'system')!.content).toContain('摘要不含思考')
    expect(rebuilt.find(m => m.role === 'assistant')!.reasoningContent).toBe('思考中')
  })
})
