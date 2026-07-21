/**
 * T2-2（会话持久化侧）：deepseek profile 下落盘重启 / 快照 / 分支恢复 reasoning
 *
 * T0-2 的扁平断言保持不变（默认无 reasoningReplay）；本文件专测 provider-aware 路径。
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
  buildSnapshotFromCompaction,
  restoreOrInjectHistory
} from '../../../../src/runtime/sessions/contextSnapshot'
import { getSessionActiveMessages } from '../../../../src/runtime/sessions/tree'
import type { ChatMessage } from '../../../../src/runtime/model/types'
import type { MessageBlock } from '../../../../src/shared/session'
import { resetSessionIndexHostForTests } from '../../../../src/runtime/sessions/SessionIndexHost'

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

function newLoop(): AgentLoop {
  return new AgentLoop(new MockModelClient(), new EventBus(), { systemPrompt: '助手' })
}

function nonSystemContext(loop: AgentLoop): ChatMessage[] {
  return loop.getContext().filter(m => m.role !== 'system')
}

describe('T2-2 会话持久化：deepseek reasoning 恢复', () => {
  let tmpDir: string

  beforeEach(() => {
    resetSessionIndexHostForTests()
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-t2-2-persist-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    resetSessionIndexHostForTests()
  })

  it('应用重启：落盘后 deepseek 恢复为多子轮 + reasoning', () => {
    const store = new SessionStore(tmpDir)
    const session = store.create('/tmp/project')
    appendThinkingToolTurn(store, session.id)

    const store2 = new SessionStore(tmpDir)
    const loop = newLoop()
    restoreOrInjectHistory(loop, store2.load(session.id)!, null, {
      reasoningReplay: 'tool-call-history'
    })
    expect(nonSystemContext(loop)).toEqual(DEEPSEEK_RECOVERY)
    // blocks 事实源未改写
    const loaded = store2.load(session.id)!
    expect(loaded.messages.find(m => m.id === 'a1')!.blocks?.some(b => b.type === 'thinking')).toBe(
      true
    )
    expect(loaded.messages.find(m => m.id === 'a1')!.content).toBe('已完成两处修复。')
  })

  it('分支切换：主分支 deepseek 正确恢复；旁路不含 tool 历史', () => {
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
    restoreOrInjectHistory(loopMain, store.load(session.id)!, null, {
      reasoningReplay: 'tool-call-history'
    })
    expect(nonSystemContext(loopMain)).toEqual(DEEPSEEK_RECOVERY)

    store.setCurrentLeaf(session.id, 'a1_alt')
    const loopAlt = newLoop()
    restoreOrInjectHistory(loopAlt, store.load(session.id)!, null, {
      reasoningReplay: 'tool-call-history'
    })
    expect(nonSystemContext(loopAlt)).toEqual([
      { role: 'user', content: '分析并修复两个问题' },
      { role: 'assistant', content: '分支 B：改用另一种方案。' }
    ])
  })

  it('kimi all-history：落盘重启同样拆子轮并保留 tool 子轮 reasoning', () => {
    const store = new SessionStore(tmpDir)
    const session = store.create('/tmp/project')
    appendThinkingToolTurn(store, session.id)

    const loop = newLoop()
    restoreOrInjectHistory(loop, store.load(session.id)!, null, {
      reasoningReplay: 'all-history'
    })
    expect(nonSystemContext(loop)).toEqual(DEEPSEEK_RECOVERY)
  })

  it('对照：无 reasoningReplay 时仍拆子轮，但不附着 reasoning', () => {
    const store = new SessionStore(tmpDir)
    const session = store.create('/tmp/project')
    appendThinkingToolTurn(store, session.id)

    const loop = newLoop()
    restoreOrInjectHistory(loop, store.load(session.id)!, null)
    const recovered = nonSystemContext(loop)
    expect(recovered.filter(m => m.role === 'assistant')).toHaveLength(3)
    expect(JSON.stringify(recovered)).not.toContain('先读 a.ts')
  })
})
