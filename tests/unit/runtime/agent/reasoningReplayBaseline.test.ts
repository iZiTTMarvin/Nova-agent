/**
 * 有 blocks 时恢复路径按子轮拆分（与运行时对齐），thinking 仍不附着（无 reasoningReplay）。
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

/** 运行时子轮序列（无 reasoning 附着） */
const SPLIT_NO_REASONING: ChatMessage[] = [
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

describe('有 blocks 时恢复路径与运行时子轮对齐', () => {
  it('buildConversationContext 拆子轮并丢弃 thinking（无 reasoningReplay）', () => {
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
    expect(recovered).toEqual(SPLIT_NO_REASONING)
    expect(recovered.filter(m => m.role === 'assistant')).toHaveLength(3)
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
    expect(nonSystem).toEqual(SPLIT_NO_REASONING)
  })
})
