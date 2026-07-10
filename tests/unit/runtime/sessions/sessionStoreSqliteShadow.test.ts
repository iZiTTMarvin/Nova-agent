/**
 * SessionStore append 双写 SQLite shadow 索引
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { SessionStore } from '../../../../src/runtime/sessions/SessionStore'
import {
  createMemorySessionIndexDb,
  type SessionIndexDb
} from '../../../../src/runtime/sessions/SessionIndexDb'
import {
  closeSessionIndex,
  getSessionIndex,
  resetSessionIndexHostForTests,
  setSessionIndexOpenFnForTests
} from '../../../../src/runtime/sessions/SessionIndexHost'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-sqlite-shadow-'))
  resetSessionIndexHostForTests()
  // 单测注入内存后端（Node 下 better-sqlite3 为 Electron ABI）
  setSessionIndexOpenFnForTests(() => createMemorySessionIndexDb())
})

afterEach(() => {
  resetSessionIndexHostForTests()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('SessionStore SQLite shadow 双写', () => {
  it('appendMessageFast 后，SQLite 索引有对应 entry，offset/parentId 正确', () => {
    const store = new SessionStore(tmpDir)
    const session = store.create('/ws')
    const dir = path.join(tmpDir, 'sessions', session.id)

    store.appendMessageFast(session.id, {
      id: 'msg_1',
      role: 'user',
      content: 'hello',
      timestamp: 1
    })

    const sqlite = getSessionIndex(dir)
    const entry = sqlite.getEntry('msg_1')
    expect(entry).not.toBeNull()
    expect(entry!.parentId).toBeNull()
    expect(entry!.offset).toBe(0)
    expect(entry!.activeDepth).toBe(0)

    const line = fs.readFileSync(path.join(dir, 'messages.jsonl'), 'utf8').split('\n')[0] + '\n'
    expect(entry!.length).toBe(Buffer.byteLength(line, 'utf8'))
  })

  it('连续 append 10 条，SQLite activeCount == 10', () => {
    const store = new SessionStore(tmpDir)
    const session = store.create('/ws')
    const dir = path.join(tmpDir, 'sessions', session.id)

    for (let i = 0; i < 10; i++) {
      store.appendMessageFast(session.id, {
        id: `msg_${i}`,
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `c${i}`,
        timestamp: i
      })
    }

    expect(getSessionIndex(dir).activeCount()).toBe(10)
  })

  it('分叉（setCurrentLeaf）后 append，SQLite 的 parentId 正确指向分叉点', () => {
    const store = new SessionStore(tmpDir)
    const session = store.create('/ws')
    const dir = path.join(tmpDir, 'sessions', session.id)

    store.appendMessageFast(session.id, {
      id: 'u1',
      role: 'user',
      content: 'q1',
      timestamp: 1
    })
    store.appendMessageFast(session.id, {
      id: 'a1',
      role: 'assistant',
      content: 'ans1',
      timestamp: 2
    })
    // 倒回 u1 分叉，再发新助手消息
    store.setCurrentLeaf(session.id, 'u1')
    store.appendMessageFast(session.id, {
      id: 'a2',
      role: 'assistant',
      content: 'ans2',
      timestamp: 3
    })

    const entry = getSessionIndex(dir).getEntry('a2')
    expect(entry).not.toBeNull()
    expect(entry!.parentId).toBe('u1')
  })

  it('关闭缓存后下次 append 自动 rebuild 并恢复', () => {
    const store = new SessionStore(tmpDir)
    const session = store.create('/ws')
    const dir = path.join(tmpDir, 'sessions', session.id)

    store.appendMessageFast(session.id, {
      id: 'm0',
      role: 'user',
      content: 'x',
      timestamp: 1
    })
    expect(getSessionIndex(dir).activeCount()).toBe(1)

    // 模拟删除 sqlite / 丢弃连接：清 Host 缓存后下次 ensure 会从 entries 重建
    closeSessionIndex(dir)
    store.appendMessageFast(session.id, {
      id: 'm1',
      role: 'assistant',
      content: 'y',
      timestamp: 2
    })

    const sqlite = getSessionIndex(dir)
    expect(sqlite.activeCount()).toBe(2)
    expect(sqlite.getEntry('m0')).not.toBeNull()
    expect(sqlite.getEntry('m1')?.parentId).toBe('m0')
  })

  it('SQLite 写失败（mock throw）不阻断 append，旧索引仍正确', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    setSessionIndexOpenFnForTests(() => {
      const db = createMemorySessionIndexDb()
      const throwing = {
        appendEntry: () => {
          throw new Error('mock sqlite write fail')
        },
        getEntry: (id: string) => db.getEntry(id),
        queryActivePathRange: (from: number, count: number) => db.queryActivePathRange(from, count),
        queryByParentId: (parentId: string | null) => db.queryByParentId(parentId),
        activeCount: () => db.activeCount(),
        getIndexedFileSize: () => db.getIndexedFileSize(),
        getCurrentLeafId: () => db.getCurrentLeafId(),
        setMeta: (k: string, v: string) => db.setMeta(k, v),
        getMeta: (k: string) => db.getMeta(k),
        isFresh: (n: number) => db.isFresh(n),
        replaceFromSnapshot: (s: Parameters<SessionIndexDb['replaceFromSnapshot']>[0]) =>
          db.replaceFromSnapshot(s),
        rebuildFromEntriesJsonl: (d: string) => db.rebuildFromEntriesJsonl(d),
        rebuildFromMessagesJsonl: (d: string) => db.rebuildFromMessagesJsonl(d),
        close: () => db.close()
      } as SessionIndexDb
      return throwing
    })

    const store = new SessionStore(tmpDir)
    const session = store.create('/ws')
    const result = store.appendMessageFast(session.id, {
      id: 'ok_msg',
      role: 'user',
      content: 'still ok',
      timestamp: 1
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.status).toBe('appended')
      expect(result.meta.messageCount).toBe(1)
    }

    const dir = path.join(tmpDir, 'sessions', session.id)
    const lines = fs.readFileSync(path.join(dir, 'messages.jsonl'), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]!).content === 'still ok' || JSON.parse(lines[0]!).blocks).toBeTruthy()
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })
})
