/**
 * memory_files + memory_fts 索引读写（依赖 MemoryDb 端口）
 */
import type { MemoryDb } from './MemoryDb'
import type { MemorySearchHit, ScannedMemoryFile } from './types'
import { negateBm25 } from './FtsQueryBuilder'

const UPSERT_SQL = `
INSERT INTO memory_files (scope_id, rel_path, fingerprint, body, mtime_ms, size)
VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT(scope_id, rel_path) DO UPDATE SET
  fingerprint = excluded.fingerprint,
  body = excluded.body,
  mtime_ms = excluded.mtime_ms,
  size = excluded.size
`

/** 列出某 scope 下已索引文件的 relPath → fingerprint */
export function listIndexedFingerprints(db: MemoryDb, scopeId: string): Map<string, string> {
  const rows = db
    .prepare(
      `SELECT rel_path AS relPath, fingerprint FROM memory_files WHERE scope_id = ?`
    )
    .all<{ relPath: string; fingerprint: string }>(scopeId)
  return new Map(rows.map((r) => [r.relPath, r.fingerprint]))
}

/** 统计某 scope 下已索引文件条数 */
export function countIndexedFiles(db: MemoryDb, scopeId: string): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS cnt FROM memory_files WHERE scope_id = ?`)
    .get<{ cnt: number }>(scopeId)
  return row?.cnt ?? 0
}

/** 写入或更新单条索引 */
export function upsertIndexedFile(
  db: MemoryDb,
  scopeId: string,
  file: Pick<ScannedMemoryFile, 'relPath' | 'body' | 'fingerprint' | 'mtimeMs' | 'size'>
): void {
  db.prepare(UPSERT_SQL).run(
    scopeId,
    file.relPath,
    file.fingerprint,
    file.body,
    file.mtimeMs,
    file.size
  )
}

/** 删除单条索引 */
export function deleteIndexedFile(db: MemoryDb, scopeId: string, relPath: string): void {
  db.prepare(`DELETE FROM memory_files WHERE scope_id = ? AND rel_path = ?`).run(scopeId, relPath)
}

/**
 * FTS 检索：BM25 取负排序，按 scope 过滤
 * @param matchQuery buildMatchQuery 产出的 MATCH 串
 * @param fetchLimit computeOverFetchLimit 产出
 */
export function searchIndexed(
  db: MemoryDb,
  scopeId: string,
  matchQuery: string,
  fetchLimit: number
): MemorySearchHit[] {
  const rows = db
    .prepare(
      `SELECT
         mf.scope_id AS scopeId,
         mf.rel_path AS relPath,
         mf.body AS body,
         bm25(memory_fts) AS bm25
       FROM memory_fts
       JOIN memory_files mf ON mf.id = memory_fts.rowid
       WHERE memory_fts MATCH ?
         AND memory_fts.scope_id = ?
       ORDER BY bm25 ASC
       LIMIT ?`
    )
    .all<{ scopeId: string; relPath: string; body: string; bm25: number }>(
      matchQuery,
      scopeId,
      fetchLimit
    )

  return rows.map((r) => ({
    scopeId: r.scopeId,
    relPath: r.relPath,
    body: r.body,
    score: negateBm25(r.bm25)
  }))
}
