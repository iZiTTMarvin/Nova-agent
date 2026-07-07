/**
 * messageCount 元数据缓存 vs 原算法（computeActivePath.length）对照单测。
 * 覆盖线性会话、分叉切叶、旧会话无 messageCount 字段等场景。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { SessionStore } from '../../../../src/runtime/sessions/SessionStore'
import { computeMessageCount } from '../../../../src/runtime/sessions/tree'
import { CURRENT_SESSION_SCHEMA_VERSION } from '../../../../src/runtime/sessions/migrations'
import type { SessionMessage } from '../../../../src/runtime/sessions/types'

let tmpDir: string

/** 原 list() 算法：全量读 jsonl + computeActivePath */
function legacyListMessageCount(
  store: SessionStore,
  sessionId: string,
  currentLeafId: string | null
): number {
  const sessionDir = path.join(tmpDir, 'sessions', sessionId)
  const raw = fs.readFileSync(path.join(sessionDir, 'messages.jsonl'), 'utf8')
  const messages: SessionMessage[] = raw
    .split('\n')
    .filter(line => line.trim())
    .map(line => JSON.parse(line) as SessionMessage)
  return computeMessageCount(messages, currentLeafId)
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-msgcount-test-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('messageCount 缓存对照', () => {
  it('线性追加：list 与旧算法一致', () => {
    const store = new SessionStore(tmpDir)
    const session = store.create('/proj')

    for (let i = 0; i < 5; i++) {
      store.appendMessage(session.id, {
        id: `m${i}`,
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `msg ${i}`,
        timestamp: i
      })
    }

    const loaded = store.load(session.id)!
    const expected = legacyListMessageCount(store, session.id, loaded.currentLeafId)
    expect(store.list()[0].messageCount).toBe(expected)
    expect(expected).toBe(5)
  })

  it('分叉切叶：setCurrentLeaf 后 messageCount 与激活路径一致', () => {
    const store = new SessionStore(tmpDir)
    const session = store.create('/proj')

    store.appendMessage(session.id, { id: 'u1', role: 'user', content: 'a', timestamp: 1 })
    store.appendMessage(session.id, { id: 'a1', role: 'assistant', content: 'b', timestamp: 2 })
    store.appendMessage(session.id, { id: 'u2', role: 'user', content: 'c', timestamp: 3 })
    store.appendMessage(session.id, { id: 'a2', role: 'assistant', content: 'd', timestamp: 4 })

    // 倒回 a1 并走兄弟分支（模拟 prepareRegenerate / edit-resend 分叉点）
    store.setCurrentLeaf(session.id, 'a1')
    store.appendMessage(session.id, { id: 'a1b', role: 'assistant', content: 'branch', timestamp: 5 })

    const loaded = store.load(session.id)!
    const expected = legacyListMessageCount(store, session.id, loaded.currentLeafId)
    expect(store.list()[0].messageCount).toBe(expected)
    // 激活路径 u1→a1→a1b = 3，总会话 5 条
    expect(expected).toBe(3)
    expect(loaded.messages).toHaveLength(5)
  })

  it('倒回 null：激活路径为空时 messageCount 为 0', () => {
    const store = new SessionStore(tmpDir)
    const session = store.create('/proj')

    store.appendMessage(session.id, { id: 'u1', role: 'user', content: 'a', timestamp: 1 })
    store.setCurrentLeaf(session.id, null)

    const expected = legacyListMessageCount(store, session.id, null)
    expect(store.list()[0].messageCount).toBe(expected)
    expect(expected).toBe(0)
  })

  it('旧会话无 messageCount：list 回算后与旧算法一致并写回磁盘', () => {
    const store = new SessionStore(tmpDir)
    const session = store.create('/proj')
    store.appendMessage(session.id, { id: 'u1', role: 'user', content: 'hi', timestamp: 1 })
    store.appendMessage(session.id, { id: 'a1', role: 'assistant', content: 'ok', timestamp: 2 })

    const metaPath = path.join(tmpDir, 'sessions', session.id, 'session.json')
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'))
    delete meta.messageCount
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2))

    const loaded = store.load(session.id)!
    const expected = legacyListMessageCount(store, session.id, loaded.currentLeafId)
    expect(store.list()[0].messageCount).toBe(expected)

    const rewritten = JSON.parse(fs.readFileSync(metaPath, 'utf8'))
    expect(rewritten.messageCount).toBe(expected)
    expect(rewritten.schemaVersion).toBe(CURRENT_SESSION_SCHEMA_VERSION)
  })

  it('旧会话无 messageCount：updateMode 写盘后补全 messageCount', () => {
    const store = new SessionStore(tmpDir)
    const session = store.create('/proj')
    store.appendMessage(session.id, { id: 'u1', role: 'user', content: 'hi', timestamp: 1 })
    store.appendMessage(session.id, { id: 'a1', role: 'assistant', content: 'ok', timestamp: 2 })

    const metaPath = path.join(tmpDir, 'sessions', session.id, 'session.json')
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'))
    delete meta.messageCount
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2))

    store.updateMode(session.id, 'plan')

    const rewritten = JSON.parse(fs.readFileSync(metaPath, 'utf8'))
    expect(rewritten.messageCount).toBe(2)
    expect(rewritten.mode).toBe('plan')
  })

  it('messageCount 为 0 但 jsonl 非空：list 自愈重算', () => {
    const store = new SessionStore(tmpDir)
    const session = store.create('/proj')
    store.appendMessage(session.id, { id: 'u1', role: 'user', content: 'hi', timestamp: 1 })
    store.appendMessage(session.id, { id: 'a1', role: 'assistant', content: 'ok', timestamp: 2 })

    const metaPath = path.join(tmpDir, 'sessions', session.id, 'session.json')
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'))
    meta.messageCount = 0
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2))

    const loaded = store.load(session.id)!
    const expected = legacyListMessageCount(store, session.id, loaded.currentLeafId)
    expect(store.list()[0].messageCount).toBe(expected)
    expect(expected).toBe(2)

    const rewritten = JSON.parse(fs.readFileSync(metaPath, 'utf8'))
    expect(rewritten.messageCount).toBe(2)
  })

  it('多会话树构造：缓存与逐会话旧算法全等', () => {
    const store = new SessionStore(tmpDir)

    // 会话 A：深链
    const sa = store.create('/a')
    store.appendMessage(sa.id, { id: 'a_u1', role: 'user', content: '1', timestamp: 1 })
    store.appendMessage(sa.id, { id: 'a_a1', role: 'assistant', content: '2', timestamp: 2 })

    // 会话 B：分叉
    const sb = store.create('/b')
    store.appendMessage(sb.id, { id: 'b_u1', role: 'user', content: '1', timestamp: 1 })
    store.appendMessage(sb.id, { id: 'b_a1', role: 'assistant', content: '2', timestamp: 2 })
    store.appendMessage(sb.id, { id: 'b_u2', role: 'user', content: '3', timestamp: 3 })
    store.setCurrentLeaf(sb.id, 'b_a1')
    store.appendMessage(sb.id, { id: 'b_a1b', role: 'assistant', content: 'alt', timestamp: 4 })

    for (const summary of store.list()) {
      const loaded = store.load(summary.id)!
      const expected = legacyListMessageCount(store, summary.id, loaded.currentLeafId)
      expect(summary.messageCount).toBe(expected)
    }
  })
})
