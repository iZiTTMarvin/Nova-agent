/**
 * SessionIndexDb — 会话消息派生索引（SQLite / 内存双后端）
 *
 * 职责：
 * - 维护 messageId → offset/length/parentId/activeDepth
 * - 支持从 entries.jsonl 或 messages.jsonl 全量重建
 * - 供分页随机读与 O(1) 追加；不含消息正文
 *
 * 后端：
 * - 生产：better-sqlite3（messages-index.sqlite，WAL）
 * - 单测：Map 内存后端（避免 Electron ABI 的 native 模块在 Node vitest 下无法加载）
 */
import * as fs from 'fs'
import * as path from 'path'
import type { MemoryDb, MemoryDbStatement } from '../memory/MemoryDb'
import { SESSION_DATA_FILE, SESSION_MESSAGES_FILE, type SessionMessage } from './types'
import {
  buildMessageIndex,
  loadMessageIndex,
  type MessageIndexEntry,
  type MessageIndexSnapshot
} from './messageIndex'
import { SESSION_INDEX_DB_FILE, initSessionIndexSchema } from './SessionIndexSchema'

/** 会话 ID 安全字符（与 SessionStore 对齐） */
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/

/** 写入/查询用的索引行（activeDepth=null 表示非激活分支） */
export interface SessionIndexEntryInput {
  messageId: string
  parentId: string | null
  offset: number
  length: number
  /** 激活路径深度；非激活为 null（entries.jsonl 的 -1 导入时转换） */
  activeDepth: number | null
}

/** 查询返回行（含写入时的 indexedFileSize） */
export interface SessionIndexEntryRow extends SessionIndexEntryInput {
  indexedFileSize: number
}

/**
 * 校验 sessionId，拒绝路径注入（../、绝对路径、非法字符）。
 * @throws Error 非法时抛出
 */
export function assertSafeSessionId(sessionId: string): void {
  if (!sessionId || typeof sessionId !== 'string') {
    throw new Error('[SessionIndexDb] 非法 sessionId: 空值')
  }
  if (sessionId.includes('..') || sessionId.includes('/') || sessionId.includes('\\')) {
    throw new Error(`[SessionIndexDb] 非法 sessionId（路径注入）: ${sessionId}`)
  }
  if (path.isAbsolute(sessionId)) {
    throw new Error(`[SessionIndexDb] 非法 sessionId（绝对路径）: ${sessionId}`)
  }
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error(`[SessionIndexDb] 非法 sessionId: ${sessionId}`)
  }
}

/** 将 entries.jsonl 的 activeDepth（-1=非激活）转为 SQLite 可空列 */
function toNullableDepth(activeDepth: number): number | null {
  return activeDepth < 0 ? null : activeDepth
}

/** 内部存储端口：SQLite 与 Map 共用 */
interface SessionIndexStore {
  upsert(row: SessionIndexEntryRow): void
  get(messageId: string): SessionIndexEntryRow | undefined
  clear(): void
  queryActiveRange(fromDepth: number, count: number): SessionIndexEntryRow[]
  queryByParentId(parentId: string | null): SessionIndexEntryRow[]
  countActive(): number
  getMeta(key: string): string | undefined
  setMeta(key: string, value: string): void
  close(): void
}

/** Map 内存后端（单测 / Host 注入） */
class MapSessionIndexStore implements SessionIndexStore {
  private readonly entries = new Map<string, SessionIndexEntryRow>()
  private readonly meta = new Map<string, string>()

  upsert(row: SessionIndexEntryRow): void {
    this.entries.set(row.messageId, { ...row })
  }

  get(messageId: string): SessionIndexEntryRow | undefined {
    const row = this.entries.get(messageId)
    return row ? { ...row } : undefined
  }

  clear(): void {
    this.entries.clear()
  }

  queryActiveRange(fromDepth: number, count: number): SessionIndexEntryRow[] {
    if (count <= 0) return []
    const active: SessionIndexEntryRow[] = []
    for (const row of this.entries.values()) {
      if (row.activeDepth !== null && row.activeDepth >= fromDepth) {
        active.push({ ...row })
      }
    }
    active.sort((a, b) => (a.activeDepth ?? 0) - (b.activeDepth ?? 0))
    return active.slice(0, count)
  }

  queryByParentId(parentId: string | null): SessionIndexEntryRow[] {
    const rows: SessionIndexEntryRow[] = []
    for (const row of this.entries.values()) {
      if (row.parentId === parentId) rows.push({ ...row })
    }
    // 按 offset 近似时间序（与写入顺序一致）
    rows.sort((a, b) => a.offset - b.offset)
    return rows
  }

  countActive(): number {
    let n = 0
    for (const row of this.entries.values()) {
      if (row.activeDepth !== null) n += 1
    }
    return n
  }

  getMeta(key: string): string | undefined {
    return this.meta.get(key)
  }

  setMeta(key: string, value: string): void {
    this.meta.set(key, value)
  }

  close(): void {
    this.entries.clear()
    this.meta.clear()
  }
}

/** better-sqlite3 适配为 MemoryDb（仅本模块内部动态 require） */
class BetterSqliteAdapter implements MemoryDb {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly db: any

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(db: any) {
    this.db = db
  }

  get sqliteVersion(): string {
    const row = this.db.prepare('SELECT sqlite_version() AS v').get() as { v: string }
    return row.v
  }

  exec(sql: string): void {
    this.db.exec(sql)
  }

  prepare(sql: string): MemoryDbStatement {
    const stmt = this.db.prepare(sql)
    return {
      run: (...params: unknown[]) => {
        const info = stmt.run(...params)
        return { changes: info.changes as number }
      },
      get: <T = unknown>(...params: unknown[]) => stmt.get(...params) as T | undefined,
      all: <T = unknown>(...params: unknown[]) => stmt.all(...params) as T[]
    }
  }

  close(): void {
    try {
      // WAL 下先 checkpoint，合并 -wal/-shm 并释放句柄；否则 Windows 上 unlink 目录会 EBUSY
      this.db.pragma('wal_checkpoint(TRUNCATE)')
    } catch {
      /* 仍继续 close */
    }
    this.db.close()
  }
}

/** SQLite 后端 */
class SqliteSessionIndexStore implements SessionIndexStore {
  private readonly upsertStmt: MemoryDbStatement
  private readonly getStmt: MemoryDbStatement
  private readonly rangeStmt: MemoryDbStatement
  private readonly byParentStmt: MemoryDbStatement
  private readonly byParentNullStmt: MemoryDbStatement
  private readonly countStmt: MemoryDbStatement
  private readonly clearStmt: MemoryDbStatement
  private readonly getMetaStmt: MemoryDbStatement
  private readonly setMetaStmt: MemoryDbStatement

  constructor(private readonly db: MemoryDb) {
    this.upsertStmt = db.prepare(
      `INSERT OR REPLACE INTO message_index
        (messageId, parentId, offset, length, activeDepth, indexedFileSize)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    this.getStmt = db.prepare(
      `SELECT messageId, parentId, offset, length, activeDepth, indexedFileSize
       FROM message_index WHERE messageId = ?`
    )
    this.rangeStmt = db.prepare(
      `SELECT messageId, parentId, offset, length, activeDepth, indexedFileSize
       FROM message_index
       WHERE activeDepth IS NOT NULL AND activeDepth >= ?
       ORDER BY activeDepth ASC
       LIMIT ?`
    )
    this.byParentStmt = db.prepare(
      `SELECT messageId, parentId, offset, length, activeDepth, indexedFileSize
       FROM message_index WHERE parentId = ? ORDER BY offset ASC`
    )
    this.byParentNullStmt = db.prepare(
      `SELECT messageId, parentId, offset, length, activeDepth, indexedFileSize
       FROM message_index WHERE parentId IS NULL ORDER BY offset ASC`
    )
    this.countStmt = db.prepare(
      `SELECT COUNT(*) AS c FROM message_index WHERE activeDepth IS NOT NULL`
    )
    this.clearStmt = db.prepare(`DELETE FROM message_index`)
    this.getMetaStmt = db.prepare(`SELECT value FROM index_meta WHERE key = ?`)
    this.setMetaStmt = db.prepare(
      `INSERT OR REPLACE INTO index_meta (key, value) VALUES (?, ?)`
    )
  }

  upsert(row: SessionIndexEntryRow): void {
    this.upsertStmt.run(
      row.messageId,
      row.parentId,
      row.offset,
      row.length,
      row.activeDepth,
      row.indexedFileSize
    )
  }

  get(messageId: string): SessionIndexEntryRow | undefined {
    const raw = this.getStmt.get<{
      messageId: string
      parentId: string | null
      offset: number
      length: number
      activeDepth: number | null
      indexedFileSize: number
    }>(messageId)
    if (!raw) return undefined
    return {
      messageId: raw.messageId,
      parentId: raw.parentId,
      offset: raw.offset,
      length: raw.length,
      activeDepth: raw.activeDepth,
      indexedFileSize: raw.indexedFileSize
    }
  }

  clear(): void {
    this.clearStmt.run()
  }

  queryActiveRange(fromDepth: number, count: number): SessionIndexEntryRow[] {
    if (count <= 0) return []
    return this.rangeStmt.all<SessionIndexEntryRow>(fromDepth, count)
  }

  queryByParentId(parentId: string | null): SessionIndexEntryRow[] {
    if (parentId === null) {
      return this.byParentNullStmt.all<SessionIndexEntryRow>()
    }
    return this.byParentStmt.all<SessionIndexEntryRow>(parentId)
  }

  countActive(): number {
    const row = this.countStmt.get<{ c: number }>()
    return row?.c ?? 0
  }

  getMeta(key: string): string | undefined {
    const row = this.getMetaStmt.get<{ value: string }>(key)
    return row?.value
  }

  setMeta(key: string, value: string): void {
    this.setMetaStmt.run(key, value)
  }

  close(): void {
    this.db.close()
  }
}

/**
 * 会话派生索引门面。
 * 对外只暴露索引操作；正文永远在 messages.jsonl。
 */
export class SessionIndexDb {
  constructor(private readonly store: SessionIndexStore) {}

  /** 追加或覆盖一条索引（幂等） */
  appendEntry(entry: SessionIndexEntryInput): void {
    const indexedFileSize = entry.offset + entry.length
    this.store.upsert({
      ...entry,
      indexedFileSize
    })
    this.store.setMeta('indexedFileSize', String(indexedFileSize))
    // 若挂在激活路径上，同步 activeCount / currentLeafId
    if (entry.activeDepth !== null) {
      this.store.setMeta('activeCount', String(this.store.countActive()))
      this.store.setMeta('currentLeafId', entry.messageId)
    }
  }

  /** 按主键查询 */
  getEntry(messageId: string): SessionIndexEntryRow | null {
    return this.store.get(messageId) ?? null
  }

  /**
   * 按 activeDepth 范围查询激活路径（升序）。
   * 用于分页：先算 fromDepth，再取 count 条。
   */
  queryActivePathRange(fromDepth: number, count: number): SessionIndexEntryRow[] {
    return this.store.queryActiveRange(fromDepth, count)
  }

  /** 按 parentId 查子节点（含非激活分支，供 branchMeta） */
  queryByParentId(parentId: string | null): SessionIndexEntryRow[] {
    return this.store.queryByParentId(parentId)
  }

  /** 激活路径消息数 */
  activeCount(): number {
    return this.store.countActive()
  }

  /** 索引记录的 messages.jsonl 字节数 */
  getIndexedFileSize(): number {
    const raw = this.store.getMeta('indexedFileSize')
    if (raw === undefined) return -1
    const n = Number(raw)
    return Number.isFinite(n) ? n : -1
  }

  /** 当前激活叶子 */
  getCurrentLeafId(): string | null {
    const v = this.store.getMeta('currentLeafId')
    if (v === undefined || v === '') return null
    return v
  }

  /** 写入 meta（供外部在 rebuild / 分叉后校正） */
  setMeta(key: string, value: string): void {
    this.store.setMeta(key, value)
  }

  getMeta(key: string): string | null {
    return this.store.getMeta(key) ?? null
  }

  /** indexedFileSize 是否与当前 jsonl 文件大小一致 */
  isFresh(fileSize: number): boolean {
    return this.getIndexedFileSize() === fileSize
  }

  /** 用 MessageIndexSnapshot 全量替换（内部） */
  replaceFromSnapshot(snapshot: MessageIndexSnapshot): void {
    this.store.clear()
    for (const [messageId, entry] of Object.entries(snapshot.entries)) {
      this.store.upsert(entryToRow(messageId, entry, snapshot.fileSize))
    }
    this.store.setMeta('indexedFileSize', String(snapshot.fileSize))
    this.store.setMeta('activeCount', String(snapshot.activeCount))
    this.store.setMeta('currentLeafId', snapshot.currentLeafId ?? '')
  }

  /** 从现有 messages.index.entries.jsonl + meta 导入 */
  rebuildFromEntriesJsonl(sessionDir: string): void {
    const snap = loadMessageIndex(sessionDir)
    if (!snap) {
      throw new Error(`[SessionIndexDb] 无可用 entries 索引: ${sessionDir}`)
    }
    this.replaceFromSnapshot(snap)
  }

  /** 从 messages.jsonl 全量扫描重建（崩溃恢复） */
  rebuildFromMessagesJsonl(sessionDir: string): void {
    const messages = readMessagesJsonlLocal(sessionDir)
    const leafId = resolveLeafId(sessionDir, messages)
    const snap = buildMessageIndex(messages, leafId)
    this.replaceFromSnapshot(snap)
  }

  close(): void {
    this.store.close()
  }
}

function entryToRow(
  messageId: string,
  entry: MessageIndexEntry,
  fileSize: number
): SessionIndexEntryRow {
  return {
    messageId,
    parentId: entry.parentId,
    offset: entry.offset,
    length: entry.length,
    activeDepth: toNullableDepth(entry.activeDepth),
    indexedFileSize: fileSize
  }
}

/** 本地读 jsonl，避免与 SessionStore 循环依赖 */
function readMessagesJsonlLocal(sessionDir: string): SessionMessage[] {
  const filePath = path.join(sessionDir, SESSION_MESSAGES_FILE)
  if (!fs.existsSync(filePath)) return []
  try {
    const content = fs.readFileSync(filePath, 'utf8')
    if (!content.trim()) return []
    const messages: SessionMessage[] = []
    for (const line of content.split('\n')) {
      if (!line.trim()) continue
      try {
        messages.push(JSON.parse(line) as SessionMessage)
      } catch {
        /* 损坏行跳过 */
      }
    }
    return messages
  } catch {
    return []
  }
}

function resolveLeafId(sessionDir: string, messages: SessionMessage[]): string | null {
  const sessionPath = path.join(sessionDir, SESSION_DATA_FILE)
  if (fs.existsSync(sessionPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(sessionPath, 'utf8')) as {
        currentLeafId?: string | null
      }
      // 显式 null 表示激活路径为空（分叉倒回起点），不得回退到末条
      if (Object.prototype.hasOwnProperty.call(raw, 'currentLeafId')) {
        return raw.currentLeafId ?? null
      }
    } catch {
      /* fall through */
    }
  }
  return messages.length > 0 ? messages[messages.length - 1]!.id : null
}

/** 打开内存索引（单测默认后端） */
export function createMemorySessionIndexDb(): SessionIndexDb {
  return new SessionIndexDb(new MapSessionIndexStore())
}

/**
 * 打开会话目录下的 messages-index.sqlite（WAL）。
 * 动态 require better-sqlite3，避免单测 import 本模块时加载 Electron ABI 原生模块。
 */
export function openIndexDb(sessionDir: string): SessionIndexDb {
  if (!fs.existsSync(sessionDir)) {
    fs.mkdirSync(sessionDir, { recursive: true })
  }
  const dbPath = path.join(sessionDir, SESSION_INDEX_DB_FILE)
  // 动态加载：仅在真正打开 SQLite 时触发 native binding
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require('better-sqlite3') as new (path: string) => {
    prepare: (sql: string) => {
      run: (...p: unknown[]) => { changes: number }
      get: (...p: unknown[]) => unknown
      all: (...p: unknown[]) => unknown[]
    }
    exec: (sql: string) => void
    close: () => void
  }
  const raw = new Database(dbPath)
  const adapter = new BetterSqliteAdapter(raw)
  initSessionIndexSchema(adapter)
  return new SessionIndexDb(new SqliteSessionIndexStore(adapter))
}

/**
 * 探测当前进程能否加载 better-sqlite3（Electron ABI 下 Node vitest 通常为 false）。
 * 供测试决定是否跑真实 SQLite 用例。
 */
export function canOpenSqliteSessionIndex(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require('better-sqlite3') as new (path: string) => { close: () => void }
    const db = new Database(':memory:')
    db.close()
    return true
  } catch {
    return false
  }
}

export { SESSION_INDEX_DB_FILE }
