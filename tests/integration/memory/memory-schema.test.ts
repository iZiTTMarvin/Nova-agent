/**
 * P1-A1：memory_fts trigram schema 集成验证（better-sqlite3 @ Node ABI）
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { openBetterSqliteMemoryDb } from '@runtime/memory/BetterSqliteMemoryDb'
import { MEMORY_FILES_SCOPE_PATH_IDX, listMemorySchemaObjects } from '@runtime/memory/MemorySchema'
import { upsertIndexedFile, searchIndexed } from '@runtime/memory/MemoryIndexer'

describe('memory schema 集成（P1-A1）', () => {
  let tempDir: string | null = null
  let db: ReturnType<typeof openBetterSqliteMemoryDb> | null = null

  afterEach(() => {
    db?.close()
    db = null
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true })
      tempDir = null
    }
  })

  it('建表后存在 memory_files、memory_fts 虚表与 FTS5 阴影索引 memory_fts_idx', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'nova-mem-schema-'))
    db = openBetterSqliteMemoryDb(join(tempDir, 'memory.db'))

    const names = listMemorySchemaObjects(db)
    expect(names).toContain('memory_files')
    expect(names).toContain('memory_fts')
    expect(names).toContain('memory_fts_idx')

    const uidx = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?`)
      .get<{ name: string }>(MEMORY_FILES_SCOPE_PATH_IDX)
    expect(uidx?.name).toBe(MEMORY_FILES_SCOPE_PATH_IDX)
  })

  it('写入索引后 trigram MATCH 可召回中文子串', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'nova-mem-schema-'))
    db = openBetterSqliteMemoryDb(join(tempDir, 'memory.db'))

    upsertIndexedFile(db, 'scope1', {
      relPath: 'MEMORY.md',
      body: '跨会话记忆需要中文检索与子串召回能力。',
      fingerprint: '100-1',
      mtimeMs: 1,
      size: 100
    })

    const hits = searchIndexed(db, 'scope1', '中文检索', 10)
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0].body).toContain('中文检索')
  })
})
