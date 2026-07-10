/**
 * SessionIndexDb 单元测试（默认走 Map 内存后端；若 better-sqlite3 可用则额外跑 SQLite 用例）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import {
  SessionIndexDb,
  assertSafeSessionId,
  canOpenSqliteSessionIndex,
  createMemorySessionIndexDb,
  openIndexDb
} from '../../../../src/runtime/sessions/SessionIndexDb'
import { SESSION_INDEX_DB_FILE } from '../../../../src/runtime/sessions/SessionIndexSchema'
import { saveMessageIndex, buildMessageIndex } from '../../../../src/runtime/sessions/messageIndex'
import { SESSION_MESSAGES_FILE, SESSION_DATA_FILE } from '../../../../src/runtime/sessions/types'
import type { SessionMessage } from '../../../../src/runtime/sessions/types'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-session-index-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function makeMsg(
  id: string,
  parentId: string | null,
  content: string,
  ts = 1
): SessionMessage {
  return { id, role: 'user', content, timestamp: ts, parentId }
}

function writeSessionFixture(
  dir: string,
  messages: SessionMessage[],
  currentLeafId: string | null
): void {
  fs.mkdirSync(dir, { recursive: true })
  const lines = messages.map(m => JSON.stringify(m)).join('\n') + (messages.length ? '\n' : '')
  fs.writeFileSync(path.join(dir, SESSION_MESSAGES_FILE), lines, 'utf8')
  fs.writeFileSync(
    path.join(dir, SESSION_DATA_FILE),
    JSON.stringify({
      schemaVersion: 4,
      id: path.basename(dir),
      workspaceRoot: '/ws',
      mode: 'default',
      currentLeafId,
      createdAt: 1,
      updatedAt: 1,
      messageCount: 0
    }),
    'utf8'
  )
  const snap = buildMessageIndex(messages, currentLeafId)
  saveMessageIndex(dir, snap)
}

describe('SessionIndexDb（内存后端）', () => {
  it('建空 DB → appendEntry 3 条 → getEntry / activeCount 正确', () => {
    const db = createMemorySessionIndexDb()
    db.appendEntry({
      messageId: 'm1',
      parentId: null,
      offset: 0,
      length: 10,
      activeDepth: 0
    })
    db.appendEntry({
      messageId: 'm2',
      parentId: 'm1',
      offset: 10,
      length: 20,
      activeDepth: 1
    })
    db.appendEntry({
      messageId: 'm3',
      parentId: 'm2',
      offset: 30,
      length: 15,
      activeDepth: 2
    })

    expect(db.activeCount()).toBe(3)
    expect(db.getEntry('m2')?.parentId).toBe('m1')
    expect(db.getEntry('m2')?.offset).toBe(10)
    expect(db.getEntry('m3')?.activeDepth).toBe(2)
    expect(db.isFresh(45)).toBe(true)
    db.close()
  })

  it('messageId 重复 INSERT OR REPLACE 不报错（幂等）', () => {
    const db = createMemorySessionIndexDb()
    db.appendEntry({
      messageId: 'm1',
      parentId: null,
      offset: 0,
      length: 10,
      activeDepth: 0
    })
    db.appendEntry({
      messageId: 'm1',
      parentId: null,
      offset: 0,
      length: 12,
      activeDepth: 0
    })
    expect(db.activeCount()).toBe(1)
    expect(db.getEntry('m1')?.length).toBe(12)
    db.close()
  })

  it('rebuildFromEntriesJsonl：从现有 entries.jsonl 导入，行数匹配', () => {
    const sessionDir = path.join(tmpDir, 'sess_entries')
    const messages = [
      makeMsg('a', null, 'one'),
      makeMsg('b', 'a', 'two'),
      makeMsg('c', 'b', 'three')
    ]
    writeSessionFixture(sessionDir, messages, 'c')

    const db = createMemorySessionIndexDb()
    db.rebuildFromEntriesJsonl(sessionDir)
    expect(db.activeCount()).toBe(3)
    expect(db.getEntry('b')?.parentId).toBe('a')
    expect(db.getCurrentLeafId()).toBe('c')
    db.close()
  })

  it('rebuildFromMessagesJsonl：从 messages.jsonl 扫描重建，offset/length 正确', () => {
    const sessionDir = path.join(tmpDir, 'sess_jsonl')
    const messages = [
      makeMsg('x', null, 'hello'),
      makeMsg('y', 'x', 'world')
    ]
    writeSessionFixture(sessionDir, messages, 'y')

    const db = createMemorySessionIndexDb()
    db.rebuildFromMessagesJsonl(sessionDir)

    const line0 = JSON.stringify(messages[0]) + '\n'
    const line1 = JSON.stringify(messages[1]) + '\n'
    const e0 = db.getEntry('x')!
    const e1 = db.getEntry('y')!
    expect(e0.offset).toBe(0)
    expect(e0.length).toBe(Buffer.byteLength(line0, 'utf8'))
    expect(e1.offset).toBe(e0.length)
    expect(e1.length).toBe(Buffer.byteLength(line1, 'utf8'))
    expect(db.isFresh(e0.length + e1.length)).toBe(true)
    db.close()
  })

  it('queryActivePathRange：线性链按 depth 查', () => {
    const db = createMemorySessionIndexDb()
    for (let i = 0; i < 5; i++) {
      db.appendEntry({
        messageId: `m${i}`,
        parentId: i === 0 ? null : `m${i - 1}`,
        offset: i * 10,
        length: 10,
        activeDepth: i
      })
    }
    const page = db.queryActivePathRange(2, 2)
    expect(page.map(r => r.messageId)).toEqual(['m2', 'm3'])
    db.close()
  })

  it('queryActivePathRange：分叉链只含激活分支', () => {
    const db = createMemorySessionIndexDb()
    // 根 → a → b（激活）；旁支 a → c（非激活）
    db.appendEntry({
      messageId: 'root',
      parentId: null,
      offset: 0,
      length: 5,
      activeDepth: 0
    })
    db.appendEntry({
      messageId: 'a',
      parentId: 'root',
      offset: 5,
      length: 5,
      activeDepth: 1
    })
    db.appendEntry({
      messageId: 'c',
      parentId: 'a',
      offset: 10,
      length: 5,
      activeDepth: null
    })
    db.appendEntry({
      messageId: 'b',
      parentId: 'a',
      offset: 15,
      length: 5,
      activeDepth: 2
    })

    const all = db.queryActivePathRange(0, 10)
    expect(all.map(r => r.messageId)).toEqual(['root', 'a', 'b'])
    expect(db.activeCount()).toBe(3)
    db.close()
  })

  it('删除索引后 rebuildFromMessagesJsonl 完整恢复', () => {
    const sessionDir = path.join(tmpDir, 'sess_recover')
    const messages = [
      makeMsg('p', null, 'a'),
      makeMsg('q', 'p', 'b'),
      makeMsg('r', 'q', 'c')
    ]
    writeSessionFixture(sessionDir, messages, 'r')

    const db1 = createMemorySessionIndexDb()
    db1.rebuildFromMessagesJsonl(sessionDir)
    expect(db1.activeCount()).toBe(3)
    db1.close()

    // 模拟「删除 sqlite」：新开空库再重建
    const db2 = createMemorySessionIndexDb()
    expect(db2.activeCount()).toBe(0)
    db2.rebuildFromMessagesJsonl(sessionDir)
    expect(db2.activeCount()).toBe(3)
    expect(db2.getEntry('q')?.parentId).toBe('p')
    db2.close()
  })

  it('assertSafeSessionId 拒绝 ../ 和绝对路径', () => {
    expect(() => assertSafeSessionId('../etc')).toThrow(/路径注入/)
    expect(() => assertSafeSessionId('foo/bar')).toThrow(/路径注入/)
    expect(() => assertSafeSessionId('foo\\bar')).toThrow(/路径注入/)
    if (path.win32.isAbsolute('C:\\abs')) {
      expect(() => assertSafeSessionId('C:\\abs')).toThrow()
    }
    expect(() => assertSafeSessionId('sess_ok-1')).not.toThrow()
  })
})

describe.runIf(canOpenSqliteSessionIndex())('SessionIndexDb（真实 SQLite）', () => {
  it('openIndexDb 写入 messages-index.sqlite 并可查询', () => {
    const sessionDir = path.join(tmpDir, 'sess_sqlite')
    fs.mkdirSync(sessionDir, { recursive: true })
    const db = openIndexDb(sessionDir)
    db.appendEntry({
      messageId: 's1',
      parentId: null,
      offset: 0,
      length: 8,
      activeDepth: 0
    })
    expect(db.getEntry('s1')?.length).toBe(8)
    db.close()
    expect(fs.existsSync(path.join(sessionDir, SESSION_INDEX_DB_FILE))).toBe(true)
  })
})
