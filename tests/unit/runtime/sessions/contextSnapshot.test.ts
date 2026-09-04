import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { AgentLoop } from '../../../../src/runtime/agent/AgentLoop'
import { EventBus } from '../../../../src/runtime/agent/EventBus'
import { MockModelClient } from '../../../../src/test-support/builders/MockModelClient'
import { makeCompactionLedger } from '../../../../src/test-support/builders/compactionLedger'
import { SessionStore } from '../../../../src/runtime/sessions/SessionStore'
import {
  classifyLedgerRestore,
  persistCompactionSnapshot,
  restoreFromLedger,
  restoreOrInjectHistory
} from '../../../../src/runtime/sessions/contextSnapshot'
import { CONTEXT_SNAPSHOT_VERSION } from '../../../../src/runtime/sessions/types'
import { extractTextFromContent } from '../../../../src/runtime/model/types'
import { PermissionManager } from '../../../../src/runtime/permissions/PermissionManager'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-ctx-snap-unit-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('contextSnapshot 纯函数', () => {
  it('persistCompactionSnapshot 写入账本且不含消息正文', () => {
    const store = new SessionStore(tmpDir)
    const session = store.create('/project')
    store.appendMessage(session.id, { id: 'u1', role: 'user', content: 'q', timestamp: 1 })
    store.appendMessage(session.id, { id: 'a1', role: 'assistant', content: 'a', timestamp: 2 })

    const ledger = makeCompactionLedger({
      summary: '摘要',
      tailFrom: { messageId: 'a1', step: 0 }
    })
    expect(persistCompactionSnapshot(store, session.id, ledger)).toBe(true)

    const loaded = store.loadContextSnapshot(session.id)!
    expect(loaded.version).toBe(CONTEXT_SNAPSHOT_VERSION)
    expect(loaded.state?.text).toBe('摘要')
    expect(loaded.tailFrom).toEqual({ messageId: 'a1', step: 0 })
    expect(loaded).not.toHaveProperty('recentMessages')
    expect(JSON.stringify(loaded)).not.toContain('"role":"user"')
  })

  it('persistCompactionSnapshot 找不到会话时返回 false', () => {
    const store = new SessionStore(tmpDir)
    const ok = persistCompactionSnapshot(
      store,
      'sess_missing',
      makeCompactionLedger({ summary: 's' })
    )
    expect(ok).toBe(false)
  })

  it('restoreOrInjectHistory 无账本时 inject 全量历史', () => {
    const store = new SessionStore(tmpDir)
    const session = store.create('/project')
    store.appendMessage(session.id, { id: 'u1', role: 'user', content: '问题', timestamp: 1 })

    const loop = new AgentLoop(new MockModelClient(), new EventBus(), {
      permissionManager: new PermissionManager(),
      systemPrompt: '助手'
    })
    restoreOrInjectHistory(loop, store.load(session.id)!, null)

    const users = loop.getContext()
      .filter(m => m.role === 'user')
      .map(m => extractTextFromContent(m.content))
    expect(users).toContain('问题')
  })

  it('同一档案+账本连续 restore 两次结果相同', () => {
    const store = new SessionStore(tmpDir)
    const session = store.create('/project')
    store.appendMessage(session.id, { id: 'u1', role: 'user', content: '旧问题', timestamp: 1 })
    store.appendMessage(session.id, { id: 'a1', role: 'assistant', content: '旧回复', timestamp: 2 })
    store.appendMessage(session.id, { id: 'u2', role: 'user', content: '最近问题', timestamp: 3 })

    const loaded = store.load(session.id)!
    const ledger = makeCompactionLedger({
      entries: [{
        id: 'c1',
        shadows: {
          from: { messageId: 'u1', step: 0 },
          to: { messageId: 'a1', step: 0 }
        },
        stub: '已折叠旧轮',
        touchedFiles: { paths: [], omittedCount: 0 },
        trigger: 'threshold',
        createdAt: 1
      }],
      state: {
        text: '已折叠旧轮',
        coversThrough: { messageId: 'a1', step: 0 },
        taskVerbatim: null,
        realityLine: '',
        revision: 1
      },
      tailFrom: { messageId: 'u2', step: 0 }
    })
    const first = restoreFromLedger(loaded, ledger, '助手')
    const second = restoreFromLedger(loaded, ledger, '助手')
    expect(first.kind).toBe('restored')
    expect(JSON.stringify(first.messages)).toBe(JSON.stringify(second.messages))
  })

  it('只允许 tailFrom 暂未落盘，条目与状态缺失坐标均判为失效', () => {
    const store = new SessionStore(tmpDir)
    const session = store.create('/project')
    store.appendMessage(session.id, { id: 'u1', role: 'user', content: '问题', timestamp: 1 })
    store.appendMessage(session.id, { id: 'a1', role: 'assistant', content: '回复', timestamp: 2 })
    const loaded = store.load(session.id)!

    expect(classifyLedgerRestore(
      loaded,
      makeCompactionLedger({
        tailFrom: { messageId: 'pending', step: 0 },
        shadows: {
          from: { messageId: 'u1', step: 0 },
          to: { messageId: 'a1', step: 0 }
        }
      })
    )).toBe('empty-tail')

    const missingEntry = makeCompactionLedger({
      tailFrom: { messageId: 'a1', step: 0 },
      state: {
        text: '摘要',
        coversThrough: { messageId: 'a1', step: 0 },
        taskVerbatim: null,
        realityLine: '',
        revision: 1
      }
    })
    expect(classifyLedgerRestore(loaded, missingEntry)).toBe('invalid')

    const missingState = makeCompactionLedger({
      entries: [{
        id: 'c1',
        shadows: {
          from: { messageId: 'u1', step: 0 },
          to: { messageId: 'a1', step: 0 }
        },
        stub: '已折叠',
        touchedFiles: { paths: [], omittedCount: 0 },
        trigger: 'threshold',
        createdAt: 1
      }],
      state: {
        text: '摘要',
        coversThrough: { messageId: 'missing', step: 0 },
        taskVerbatim: null,
        realityLine: '',
        revision: 1
      },
      tailFrom: { messageId: 'a1', step: 0 }
    })

    const invalidEntryStep = makeCompactionLedger({
      shadows: {
        from: { messageId: 'u1', step: 1 },
        to: { messageId: 'a1', step: 0 }
      },
      tailFrom: { messageId: 'a1', step: 0 }
    })
    expect(classifyLedgerRestore(loaded, invalidEntryStep)).toBe('invalid')

    const invalidTailStep = makeCompactionLedger({
      shadows: {
        from: { messageId: 'u1', step: 0 },
        to: { messageId: 'a1', step: 0 }
      },
      tailFrom: { messageId: 'a1', step: 1 }
    })
    expect(classifyLedgerRestore(loaded, invalidTailStep)).toBe('invalid')
    expect(classifyLedgerRestore(loaded, missingState)).toBe('invalid')
  })
})
