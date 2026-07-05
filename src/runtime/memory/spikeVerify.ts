/**
 * FTS5 trigram 冒烟验证逻辑（仅依赖 MemoryDb 端口，无原生模块 import）。
 * 供 Electron spike、集成测试、打包冒烟复用。
 */

import type { MemoryDb } from './MemoryDb'

/** trigram FTS5 验证结果 */
export interface TrigramSpikeResult {
  ok: boolean
  sqliteVersion: string
  /** SQLite 主版本号是否 ≥ 3.34（trigram 内建门槛） */
  sqliteMeetsTrigram: boolean
  trigramTableCreated: boolean
  trigramMatchHit: boolean
  /** 文件路径模式下二次打开后仍能 MATCH */
  persistedAfterReopen: boolean
  errors: string[]
}

const MIN_SQLITE_MAJOR = 3
const MIN_SQLITE_MINOR = 34

/** 解析 "3.45.1" 形式版本号 */
function parseSqliteVersion(version: string): { major: number; minor: number } {
  const [major, minor] = version.split('.').map((n) => parseInt(n, 10))
  return { major: major ?? 0, minor: minor ?? 0 }
}

function sqliteMeetsTrigram(version: string): boolean {
  const { major, minor } = parseSqliteVersion(version)
  return major > MIN_SQLITE_MAJOR || (major === MIN_SQLITE_MAJOR && minor >= MIN_SQLITE_MINOR)
}

/**
 * 在已打开的 MemoryDb 上验证 trigram FTS5：建表 → 中文 INSERT → 中文子串 MATCH。
 * @param reopen 可选：关闭后重新打开同一文件路径的工厂（验证持久化）
 */
export function verifyTrigramFts5(
  db: MemoryDb,
  reopen?: () => MemoryDb
): TrigramSpikeResult {
  const errors: string[] = []
  const version = db.sqliteVersion
  const meetsTrigram = sqliteMeetsTrigram(version)

  if (!meetsTrigram) {
    errors.push(`SQLite ${version} < 3.34，不支持内建 trigram tokenizer`)
  }

  let trigramTableCreated = false
  let trigramMatchHit = false
  let persistedAfterReopen = false

  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS spike_fts USING fts5(
        body,
        tokenize='trigram'
      );
    `)
    trigramTableCreated = true

    db.exec(`DELETE FROM spike_fts;`)
    const insert = db.prepare(`INSERT INTO spike_fts(body) VALUES (?)`)
    insert.run('跨会话记忆系统需要支持中文全文检索与子串召回。')

    const query = db.prepare(
      `SELECT body FROM spike_fts WHERE body MATCH ? LIMIT 1`
    )
    const row = query.get<{ body: string }>('中文全文')
    trigramMatchHit = row?.body?.includes('中文全文') === true

    if (!trigramMatchHit) {
      errors.push('trigram MATCH 未命中中文子串 query「中文全文」')
    }
  } catch (err) {
    errors.push(`trigram 验证异常: ${err instanceof Error ? err.message : String(err)}`)
  }

  if (reopen) {
    try {
      db.close()
      const db2 = reopen()
      try {
        const row = db2
          .prepare(`SELECT body FROM spike_fts WHERE body MATCH ? LIMIT 1`)
          .get<{ body: string }>('跨会话')
        persistedAfterReopen = row?.body?.includes('跨会话') === true
        if (!persistedAfterReopen) {
          errors.push('重新打开后未能从持久化文件 MATCH 到「跨会话」')
        }
      } finally {
        db2.close()
      }
    } catch (err) {
      errors.push(`持久化重开验证异常: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const ok =
    meetsTrigram &&
    trigramTableCreated &&
    trigramMatchHit &&
    (reopen == null || persistedAfterReopen) &&
    errors.length === 0

  return {
    ok,
    sqliteVersion: version,
    sqliteMeetsTrigram: meetsTrigram,
    trigramTableCreated,
    trigramMatchHit,
    persistedAfterReopen: reopen != null ? persistedAfterReopen : true,
    errors
  }
}
