/**
 * T0-2（agent 侧）：buildConversationContext / AgentLoop 扁平恢复基线
 *
 * 证明「thinking → tool A → thinking → tool B → final」经 contextBuilder
 * 恢复后与理想运行时子轮序列不同。会话落盘场景见 sessions/reasoningHistoryPersistence.test.ts。
 */
import { describe, expect, it } from 'vitest'
import { AgentLoop } from '../../../../src/runtime/agent/AgentLoop'
import { EventBus } from '../../../../src/runtime/agent/EventBus'
import { buildConversationContext } from '../../../../src/runtime/agent/context/contextBuilder'
import { MockModelClient } from '../../../../src/test-support/builders/MockModelClient'
import { restoreOrInjectHistory } from '../../../../src/runtime/sessions/contextSnapshot'
import type { SessionData } from '../../../../src/runtime/sessions/types'
import type { ChatMessage } from '../../../../src/runtime/model/types'
import type { MessageBlock } from '../../../../src/shared/session'

/** 理想运行时：三段 assistant 子轮（含两次 tool 间隙） */
const IDEAL_RUNTIME_SEQUENCE: ChatMessage[] = [
  { role: 'user', content: '分析并修复两个问题' },
  {
    role: 'assistant',
    content: '',
    toolCalls: [{ id: 'tc_a', name: 'read', arguments: '{"path":"a.ts"}' }]
  },
  { role: 'tool', content: 'content of a.ts', toolCallId: 'tc_a' },
  {
    role: 'assistant',
    content: '',
    toolCalls: [{ id: 'tc_b', name: 'edit', arguments: '{"path":"b.ts","old":"x","new":"y"}' }]
  },
  { role: 'tool', content: 'edited b.ts', toolCallId: 'tc_b' },
  { role: 'assistant', content: '已完成两处修复。' }
]

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

/** 改造前扁平恢复结果 */
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

/** 与 contextBuilder.test.ts 一致：不写 parentId，由 ensureMessageParentChain 串链 */
function makeSession(messages: SessionData['messages']): SessionData {
  return {
    schemaVersion: 8,
    id: 'sess_t0_2',
    workspaceRoot: '/tmp/project',
    mode: 'default',
    messages,
    createdAt: 1,
    updatedAt: 2
  }
}

describe('T0-2 Agent 侧：reasoning 扁平丢失基线', () => {
  it('buildConversationContext 压扁子轮并丢弃 thinking', () => {
    const session = makeSession([
      { id: 'u1', role: 'user', content: '分析并修复两个问题', timestamp: 1 },
      {
        id: 'a1',
        role: 'assistant',
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
    ])

    const recovered = buildConversationContext(session, 'default')

    expect(JSON.stringify(recovered)).not.toContain('先读 a.ts 确认问题根因')
    expect(JSON.stringify(recovered)).not.toContain('再改 b.ts 对齐接口')
    expect(recovered).toEqual(FLATTENED_RECOVERY)
    // 明确记录与理想运行时的差异，供 T2 对照
    expect(IDEAL_RUNTIME_SEQUENCE.filter(m => m.role === 'assistant')).toHaveLength(3)
    expect(recovered.filter(m => m.role === 'assistant')).toHaveLength(1)
    expect(recovered).not.toEqual(IDEAL_RUNTIME_SEQUENCE)
  })

  it('新 AgentLoop + restoreOrInjectHistory(无快照) 与 contextBuilder 一致', () => {
    const session = makeSession([
      { id: 'u1', role: 'user', content: '分析并修复两个问题', timestamp: 1 },
      {
        id: 'a1',
        role: 'assistant',
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
    ])

    const loop = new AgentLoop(new MockModelClient(), new EventBus(), {
      systemPrompt: '助手'
    })
    restoreOrInjectHistory(loop, session, null)

    const nonSystem = loop.getContext().filter(m => m.role !== 'system')
    expect(nonSystem).toEqual(FLATTENED_RECOVERY)
    expect(nonSystem).not.toEqual(IDEAL_RUNTIME_SEQUENCE)
  })
})
