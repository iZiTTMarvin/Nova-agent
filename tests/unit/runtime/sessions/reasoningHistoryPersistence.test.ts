/**
 * 会话持久化侧：thinking→tool→thinking→tool→final 落盘后恢复基线
 *
 * 与 agent/reasoningReplayBaseline.test.ts 互补：本文件聚焦 SessionStore
 * 落盘、context snapshot、分支切换与应用重启后的扁平恢复现状。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { AgentLoop } from '../../../../src/runtime/agent/AgentLoop'
import { EventBus } from '../../../../src/runtime/agent/EventBus'
import { MockModelClient } from '../../../../src/test-support/builders/MockModelClient'
import { SessionStore } from '../../../../src/runtime/sessions/SessionStore'
import {
  restoreOrInjectHistory
} from '../../../../src/runtime/sessions/contextSnapshot'
import { makeCompactionLedger } from '../../../../src/test-support/builders/compactionLedger'
import { getSessionActiveMessages } from '../../../../src/runtime/sessions/tree'
import type { ChatMessage } from '../../../../src/runtime/model/types'
import type { MessageBlock } from '../../../../src/shared/session'
import { extractTextFromContent } from '../../../../src/runtime/model/types'
import { resetSessionIndexHostForTests } from '../../../../src/runtime/sessions/SessionIndexHost'
import { PermissionManager } from '../../../../src/runtime/permissions/PermissionManager'

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

const SPLIT_NO_REASONING: ChatMessage[] = [
  { role: 'user', content: '分析并修复两个问题', origin: { messageId: 'u1', step: 0 } },
  {
    role: 'assistant',
    content: '',
    toolCalls: [{ id: 'tc_a', name: 'read', arguments: '{"path":"a.ts"}' }],
    origin: { messageId: 'a1', step: 0 }
  },
  { role: 'tool', content: 'content of a.ts', toolCallId: 'tc_a', origin: { messageId: 'a1', step: 0 } },
  {
    role: 'assistant',
    content: '',
    toolCalls: [{ id: 'tc_b', name: 'edit', arguments: '{"path":"b.ts","old":"x","new":"y"}' }],
    origin: { messageId: 'a1', step: 1 }
  },
  { role: 'tool', content: 'edited b.ts', toolCallId: 'tc_b', origin: { messageId: 'a1', step: 1 } },
  { role: 'assistant', content: '已完成两处修复。', origin: { messageId: 'a1', step: 2 } }
]

function appendThinkingToolTurn(store: SessionStore, sessionId: string): void {
  store.appendMessage(sessionId, {
    id: 'u1',
    role: 'user',
    content: '分析并修复两个问题',
    timestamp: 1
  })
  store.appendMessage(sessionId, {
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
    messageSchemaVersion: 1,
    timestamp: 2
  })
}

function assertSplitNoReasoning(recovered: ChatMessage[]): void {
  const serialized = JSON.stringify(recovered)
  expect(serialized).not.toContain('先读 a.ts 确认问题根因')
  expect(serialized).not.toContain('再改 b.ts 对齐接口')
  expect(recovered.filter(m => m.role === 'assistant')).toHaveLength(3)
  expect(recovered).toEqual(SPLIT_NO_REASONING)
}

function newLoop(): AgentLoop {
  return new AgentLoop(new MockModelClient(), new EventBus(), {
    permissionManager: new PermissionManager(),
    systemPrompt: '助手'
  })
}

function nonSystemContext(loop: AgentLoop): ChatMessage[] {
  return loop.getContext().filter(m => m.role !== 'system')
}

describe('会话持久化：有 blocks 时拆子轮恢复（无 reasoning 附着）', () => {
  let tmpDir: string

  beforeEach(() => {
    resetSessionIndexHostForTests()
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-t0-2-persist-'))
  })

  afterEach(() => {
  resetSessionIndexHostForTests()
    fs.rmSync(tmpDir, { recursive: true, force: true })
    resetSessionIndexHostForTests()
  })

  it('落盘后 load：blocks 中 thinking 仍在磁盘事实源，但投影 content 不含 thinking', () => {
    const store = new SessionStore(tmpDir)
    const session = store.create('/tmp/project')
    appendThinkingToolTurn(store, session.id)

    const loaded = store.load(session.id)!
    const assistant = loaded.messages.find(m => m.id === 'a1')!
    // blocks 事实源保留 thinking（供 UI）
    expect(assistant.blocks?.some(b => b.type === 'thinking')).toBe(true)
    // 投影 content 只有 text 块
    expect(assistant.content).toBe('已完成两处修复。')
    expect(assistant.toolCalls?.map(t => t.id)).toEqual(['tc_a', 'tc_b'])
  })

  it('应用重启：新 SessionStore + 新 AgentLoop 恢复为拆子轮上下文', () => {
    const store = new SessionStore(tmpDir)
    const session = store.create('/tmp/project')
    appendThinkingToolTurn(store, session.id)

    const store2 = new SessionStore(tmpDir)
    const loop = newLoop()
    restoreOrInjectHistory(loop, store2.load(session.id)!, null)
    assertSplitNoReasoning(nonSystemContext(loop))
  })

  it('context 账本命中后仍无 reasoning 正文泄漏', () => {
    const store = new SessionStore(tmpDir)
    const session = store.create('/tmp/project')
    appendThinkingToolTurn(store, session.id)

    const snapshot = makeCompactionLedger({
      summary: '已完成 a/b 修复',
      tailFrom: { messageId: 'a1', step: 1 },
      shadows: {
        from: { messageId: 'u1', step: 0 },
        to: { messageId: 'a1', step: 0 }
      }
    })
    store.saveContextSnapshot(session.id, snapshot)
    store.appendMessage(session.id, {
      id: 'u2',
      role: 'user',
      content: '再确认一下',
      timestamp: 3
    })

    const loop = newLoop()
    restoreOrInjectHistory(
      loop,
      store.load(session.id)!,
      store.loadContextSnapshot(session.id)
    )

    const systemText = extractTextFromContent(
      loop.getContext().find(m => m.role === 'system')!.content
    )
    expect(systemText).toContain('已完成 a/b 修复')
    expect(JSON.stringify(nonSystemContext(loop))).not.toContain('先读 a.ts')
  })

  it('tailFrom 尚未落盘时保留摘要并给出空尾部', () => {
    const store = new SessionStore(tmpDir)
    const session = store.create('/tmp/project')
    appendThinkingToolTurn(store, session.id)

    const snapshot = makeCompactionLedger({
      summary: '旧摘要',
      tailFrom: { messageId: 'msg_does_not_exist', step: 0 },
      shadows: {
        from: { messageId: 'u1', step: 0 },
        to: { messageId: 'a1', step: 0 }
      }
    })
    store.saveContextSnapshot(session.id, snapshot)

    const loop = newLoop()
    restoreOrInjectHistory(
      loop,
      store.load(session.id)!,
      store.loadContextSnapshot(session.id)
    )

    const systemText = extractTextFromContent(
      loop.getContext().find(m => m.role === 'system')!.content
    )
    expect(systemText).toContain('旧摘要')
    expect(nonSystemContext(loop)).toEqual([])
  })

  it('分支切换：主分支拆子轮恢复；旁路分支不含主分支 tool 历史', () => {
    const store = new SessionStore(tmpDir)
    const session = store.create('/tmp/project')
    appendThinkingToolTurn(store, session.id)

    store.setCurrentLeaf(session.id, 'u1')
    store.appendMessage(session.id, {
      id: 'a1_alt',
      role: 'assistant',
      content: '分支 B：改用另一种方案。',
      blocks: [{ type: 'text', content: '分支 B：改用另一种方案。' }],
      messageSchemaVersion: 1,
      timestamp: 3
    })

    store.setCurrentLeaf(session.id, 'a1')
    expect(getSessionActiveMessages(store.load(session.id)!).map(m => m.id)).toEqual([
      'u1',
      'a1'
    ])
    const loopMain = newLoop()
    restoreOrInjectHistory(loopMain, store.load(session.id)!, null)
    assertSplitNoReasoning(nonSystemContext(loopMain))

    store.setCurrentLeaf(session.id, 'a1_alt')
    const loopAlt = newLoop()
    restoreOrInjectHistory(loopAlt, store.load(session.id)!, null)
    expect(nonSystemContext(loopAlt)).toEqual([
      { role: 'user', content: '分析并修复两个问题', origin: { messageId: 'u1', step: 0 } },
      {
        role: 'assistant',
        content: '分支 B：改用另一种方案。',
        origin: { messageId: 'a1_alt', step: 0 }
      }
    ])
  })
})
