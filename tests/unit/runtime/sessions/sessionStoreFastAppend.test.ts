/**
 * T5-1 SessionStore O(1) 热追加 / patch / 索引
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { SessionStore } from '../../../../src/runtime/sessions/SessionStore'
import { SESSION_MESSAGES_FILE } from '../../../../src/runtime/sessions/types'
import { SESSION_MESSAGE_INDEX_FILE } from '../../../../src/runtime/sessions/messageIndex'
import { SESSION_MESSAGE_PATCHES_FILE, readMessagePatches } from '../../../../src/runtime/sessions/messagePatches'
import { createMemorySessionIndexDb } from '../../../../src/runtime/sessions/SessionIndexDb'
import {
  getSessionIndex,
  resetSessionIndexHostForTests,
  setSessionIndexOpenFnForTests
} from '../../../../src/runtime/sessions/SessionIndexHost'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-t5-session-'))
  resetSessionIndexHostForTests()
  setSessionIndexOpenFnForTests(() => createMemorySessionIndexDb())
})

afterEach(() => {
  resetSessionIndexHostForTests()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('T5-1 SessionStore O(1) 热追加', () => {
  it('appendMessageFast：messageCount = previousActiveCount + 1，不依赖全图扫描结果', () => {
    const store = new SessionStore(tmpDir)
    const session = store.create('/ws')

    const m1 = store.appendMessageFast(session.id, {
      id: 'msg_1',
      role: 'user',
      content: 'hello',
      timestamp: 1
    })
    expect(m1.ok).toBe(true)
    if (!m1.ok) return
    expect(m1.meta.messageCount).toBe(1)
    expect(m1.meta.currentLeafId).toBe('msg_1')

    const m2 = store.appendMessageFast(session.id, {
      id: 'msg_2',
      role: 'assistant',
      content: 'hi',
      timestamp: 2
    })
    expect(m2.ok).toBe(true)
    if (!m2.ok) return
    expect(m2.meta.messageCount).toBe(2)
    expect(m2.meta.currentLeafId).toBe('msg_2')

    // 派生索引应存在且 activeCount 对齐
    const dir = path.join(tmpDir, 'sessions', session.id)
    const index = getSessionIndex(dir)
    expect(index.activeCount()).toBe(2)
    expect(index.getEntry('msg_1')).not.toBeNull()
    expect(index.getEntry('msg_2')!.activeDepth).toBe(1)
  })

  it('连续追加后 loadActivePath 可读完整激活路径', () => {
    const store = new SessionStore(tmpDir)
    const session = store.create('/ws')
    for (let i = 0; i < 5; i++) {
      store.appendMessageFast(session.id, {
        id: `msg_${i}`,
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `c${i}`,
        timestamp: i
      })
    }
    const active = store.loadActivePath(session.id)
    expect(active).not.toBeNull()
    expect(active!.messages).toHaveLength(5)
    expect(active!.messageCount).toBe(5)
  })

  it('verification 用 append-only patch，不重写 messages.jsonl', () => {
    const store = new SessionStore(tmpDir)
    const session = store.create('/ws')
    store.appendMessageFast(session.id, {
      id: 'msg_a',
      role: 'assistant',
      content: 'done',
      timestamp: 1
    })

    const dir = path.join(tmpDir, 'sessions', session.id)
    const jsonlBefore = fs.readFileSync(path.join(dir, SESSION_MESSAGES_FILE), 'utf8')

    expect(store.appendMessagePatch(session.id, 'msg_a', { verificationSummary: '✓ ok' })).toBe(true)

    const jsonlAfter = fs.readFileSync(path.join(dir, SESSION_MESSAGES_FILE), 'utf8')
    expect(jsonlAfter).toBe(jsonlBefore)

    const patches = readMessagePatches(dir)
    expect(patches).toHaveLength(1)
    expect(patches[0].patch.verificationSummary).toBe('✓ ok')

    const loaded = store.load(session.id)
    expect(loaded!.messages[0].verificationSummary).toBe('✓ ok')
  })

  it('compactMessagePatches 合并后清空 patch 文件', () => {
    const store = new SessionStore(tmpDir)
    const session = store.create('/ws')
    store.appendMessageFast(session.id, {
      id: 'msg_a',
      role: 'assistant',
      content: 'done',
      timestamp: 1
    })
    store.appendMessagePatch(session.id, 'msg_a', { verificationSummary: '✓ ok' })
    expect(store.compactMessagePatches(session.id)).toBe(true)

    const dir = path.join(tmpDir, 'sessions', session.id)
    const patchPath = path.join(dir, SESSION_MESSAGE_PATCHES_FILE)
    const patchContent = fs.existsSync(patchPath) ? fs.readFileSync(patchPath, 'utf8').trim() : ''
    expect(patchContent).toBe('')

    const line = fs.readFileSync(path.join(dir, SESSION_MESSAGES_FILE), 'utf8').trim().split('\n')[0]
    expect(JSON.parse(line).verificationSummary).toBe('✓ ok')
  })

  it('loadSessionPage 与 loadMessagesPage 同语义', () => {
    const store = new SessionStore(tmpDir)
    const session = store.create('/ws')
    for (let i = 0; i < 10; i++) {
      store.appendMessageFast(session.id, {
        id: `m${i}`,
        role: 'user',
        content: `c${i}`,
        timestamp: i
      })
    }
    const a = store.loadSessionPage(session.id, { limit: 3 })
    const b = store.loadMessagesPage(session.id, { limit: 3 })
    expect(a?.messages.map(m => m.id)).toEqual(b?.messages.map(m => m.id))
    expect(a?.hasMore).toBe(true)
  })

  it('追加后 SQLite 派生索引有对应 entry（不再写 legacy index 文件）', () => {
    const store = new SessionStore(tmpDir)
    const session = store.create('/ws')
    store.appendMessageFast(session.id, {
      id: 'x',
      role: 'user',
      content: 'x',
      timestamp: 1
    })
    const dir = path.join(tmpDir, 'sessions', session.id)
    const indexPath = path.join(dir, SESSION_MESSAGE_INDEX_FILE)
    expect(fs.existsSync(indexPath)).toBe(false)
    expect(getSessionIndex(dir).getEntry('x')).not.toBeNull()
  })

  it('同 messageId 重试返回 already_exists，不重复追加 JSONL', () => {
    const store = new SessionStore(tmpDir)
    const session = store.create('/ws')
    const first = store.appendMessageFast(session.id, {
      id: 'dup_1',
      role: 'assistant',
      content: 'a',
      timestamp: 1
    })
    expect(first.ok && first.status === 'appended').toBe(true)

    const second = store.appendMessageFast(session.id, {
      id: 'dup_1',
      role: 'assistant',
      content: 'b',
      timestamp: 2
    })
    expect(second.ok && second.status === 'already_exists').toBe(true)

    const dir = path.join(tmpDir, 'sessions', session.id)
    const lines = fs.readFileSync(path.join(dir, SESSION_MESSAGES_FILE), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]).content === 'a' || JSON.parse(lines[0]).blocks).toBeTruthy()
  })
})
