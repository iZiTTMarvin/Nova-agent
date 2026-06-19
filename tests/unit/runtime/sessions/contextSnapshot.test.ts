import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { AgentLoop } from '../../../../src/runtime/agent/AgentLoop'
import { EventBus } from '../../../../src/runtime/agent/EventBus'
import { MockModelClient } from '../../../../src/test-support/builders/MockModelClient'
import { SessionStore } from '../../../../src/runtime/sessions/SessionStore'
import {
  buildSnapshotFromCompaction,
  persistCompactionSnapshot,
  restoreOrInjectHistory
} from '../../../../src/runtime/sessions/contextSnapshot'
import { CONTEXT_SNAPSHOT_VERSION } from '../../../../src/runtime/sessions/types'
import { extractTextFromContent } from '../../../../src/runtime/model/types'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-ctx-snap-unit-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('contextSnapshot 纯函数', () => {
  it('buildSnapshotFromCompaction 字段与 agentHandler 契约一致', () => {
    const store = new SessionStore(tmpDir)
    const session = store.create('/project')
    store.appendMessage(session.id, { id: 'u1', role: 'user', content: 'q', timestamp: 1 })
    store.appendMessage(session.id, { id: 'a1', role: 'assistant', content: 'a', timestamp: 2 })

    const loaded = store.load(session.id)!
    const snapshot = buildSnapshotFromCompaction(
      loaded,
      [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'recent' }
      ],
      { summary: '摘要', compactionLevel: 2, trigger: 'idle' }
    )

    expect(snapshot.version).toBe(CONTEXT_SNAPSHOT_VERSION)
    expect(snapshot.summary).toBe('摘要')
    expect(snapshot.recentMessages).toEqual([{ role: 'user', content: 'recent' }])
    expect(snapshot.lastMessageId).toBe('a1')
    expect(snapshot.compactionLevel).toBe(2)
  })

  it('persistCompactionSnapshot 找不到会话时返回 false', () => {
    const store = new SessionStore(tmpDir)
    const ok = persistCompactionSnapshot(
      store,
      'sess_missing',
      [{ role: 'user', content: 'x' }],
      { summary: 's', compactionLevel: 0, trigger: 'threshold' }
    )
    expect(ok).toBe(false)
  })

  it('restoreOrInjectHistory 无快照时 inject 全量历史', () => {
    const store = new SessionStore(tmpDir)
    const session = store.create('/project')
    store.appendMessage(session.id, { id: 'u1', role: 'user', content: '问题', timestamp: 1 })

    const loop = new AgentLoop(new MockModelClient(), new EventBus(), {
      systemPrompt: '助手'
    })
    restoreOrInjectHistory(loop, store.load(session.id)!, null)

    const users = loop.getContext()
      .filter(m => m.role === 'user')
      .map(m => extractTextFromContent(m.content))
    expect(users).toContain('问题')
  })
})
