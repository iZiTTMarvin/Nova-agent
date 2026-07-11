/**
 * SessionIndexHost — 按 sessionDir 缓存 SessionIndexDb 连接
 *
 * 参考 MemoryServiceHost：懒加载、退出关闭、单测可重置/注入后端。
 * 默认尝试打开 SQLite；单测可 setOpenFnForTests 注入内存后端。
 */
import * as fs from 'fs'
import * as path from 'path'
import {
  SessionIndexDb,
  createMemorySessionIndexDb,
  openIndexDb,
  canOpenSqliteSessionIndex
} from './SessionIndexDb'
import { SESSION_INDEX_DB_FILE } from './SessionIndexSchema'

/** 打开索引的工厂；返回 null 表示本会话暂不可用（调用方走旧索引） */
export type SessionIndexOpenFn = (sessionDir: string) => SessionIndexDb

const cache = new Map<string, SessionIndexDb>()
let openFn: SessionIndexOpenFn | null = null
/** 默认：能加载 better-sqlite3 则用 SQLite，否则用内存（仅保证进程不崩；生产 Electron 必有 native） */
let defaultPreferSqlite = true

/** 解析规范化 sessionDir 作为 cache key */
function cacheKey(sessionDir: string): string {
  return path.resolve(sessionDir)
}

/**
 * 获取或打开会话索引。
 * - 已缓存：直接返回
 * - 首次：调用 openFn / 默认策略；打开后若文件不存在或与 jsonl 不同步，由调用方决定 rebuild
 */
export function getSessionIndex(sessionDir: string): SessionIndexDb {
  const key = cacheKey(sessionDir)
  const hit = cache.get(key)
  if (hit) return hit

  const db = (openFn ?? defaultOpen)(sessionDir)
  cache.set(key, db)
  return db
}

function defaultOpen(sessionDir: string): SessionIndexDb {
  if (defaultPreferSqlite && canOpenSqliteSessionIndex()) {
    return openIndexDb(sessionDir)
  }
  // Node vitest（Electron ABI 的 better-sqlite3 无法加载）回退内存，避免拖垮现有 SessionStore 单测
  return createMemorySessionIndexDb()
}

/**
 * 确保索引与 messages.jsonl / currentLeafId 对齐。
 * @param jsonlFileSize 当前 messages.jsonl 字节数
 * @param currentLeafId 若提供，与索引 meta 不一致时强制重建激活路径
 */
export function ensureSessionIndexFresh(
  sessionDir: string,
  jsonlFileSize: number,
  currentLeafId?: string | null
): SessionIndexDb {
  const db = getSessionIndex(sessionDir)
  const leafOk =
    currentLeafId === undefined ||
    normalizeLeaf(db.getCurrentLeafId()) === normalizeLeaf(currentLeafId)
  if (db.isFresh(jsonlFileSize) && leafOk) return db

  const entriesPath = path.join(sessionDir, 'messages.index.entries.jsonl')
  const metaPath = path.join(sessionDir, 'messages.index.meta.json')
  try {
    // leaf 不一致时必须从 jsonl 重建（entries 的 activeDepth 也可能过期）
    if (
      leafOk &&
      fs.existsSync(entriesPath) &&
      fs.existsSync(metaPath)
    ) {
      db.rebuildFromEntriesJsonl(sessionDir)
      markLegacyIndexDeprecated(sessionDir)
      // entries 重建后若 leaf 仍不匹配（极少），再走 jsonl
      if (
        currentLeafId !== undefined &&
        normalizeLeaf(db.getCurrentLeafId()) !== normalizeLeaf(currentLeafId)
      ) {
        db.rebuildFromMessagesJsonl(sessionDir)
      }
    } else {
      db.rebuildFromMessagesJsonl(sessionDir)
    }
  } catch (err) {
    console.warn('[SessionIndexHost] 索引重建失败，尝试从 messages.jsonl:', err)
    db.rebuildFromMessagesJsonl(sessionDir)
  }
  return db
}

/** 迁移成功后保留 entries.jsonl，仅落盘 deprecated 标记（不删除旧文件） */
function markLegacyIndexDeprecated(sessionDir: string): void {
  const marker = path.join(sessionDir, 'messages.index.DEPRECATED')
  if (fs.existsSync(marker)) return
  try {
    fs.writeFileSync(
      marker,
      'legacy messages.index.entries.jsonl retained for crash rebuild; SQLite messages-index.sqlite is primary\n',
      'utf8'
    )
  } catch {
    /* ignore */
  }
}

function normalizeLeaf(leaf: string | null | undefined): string | null {
  if (leaf === undefined || leaf === null || leaf === '') return null
  return leaf
}

/** 关闭并移除某个会话的缓存连接（删目录前的唯一正确入口） */
export function closeSessionIndex(sessionDir: string): void {
  const key = cacheKey(sessionDir)
  const db = cache.get(key)
  if (!db) return
  try {
    // close 内含 WAL checkpoint；释放后调用方才能安全 rmSync 会话目录
    db.close()
  } catch {
    /* ignore */
  }
  cache.delete(key)
}

/** 应用退出时关闭全部连接 */
export function closeAllSessionIndexes(): void {
  for (const [key, db] of cache) {
    try {
      db.close()
    } catch {
      /* ignore */
    }
    cache.delete(key)
  }
}

/** 单测注入打开工厂；传 null 恢复默认 */
export function setSessionIndexOpenFnForTests(fn: SessionIndexOpenFn | null): void {
  openFn = fn
}

/** 单测重置：关连接 + 清工厂 */
export function resetSessionIndexHostForTests(): void {
  closeAllSessionIndexes()
  openFn = null
  defaultPreferSqlite = true
}

/** 测试辅助：当前缓存数量 */
export function sessionIndexCacheSizeForTests(): number {
  return cache.size
}

export { SESSION_INDEX_DB_FILE }
