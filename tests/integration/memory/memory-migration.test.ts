/**
 * memory.db schema 迁移集成测试（better-sqlite3 @ Node ABI）：
 * 旧库无损升级、幂等重放、失败整体回滚、高版本 fail-closed。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { BetterSqliteMemoryDb, openBetterSqliteMemoryDb } from '@runtime/memory/BetterSqliteMemoryDb'
import { initMemorySchema } from '@runtime/memory/MemorySchema'
import { upsertIndexedFile, searchIndexed } from '@runtime/memory/MemoryIndexer'
import {
  migrateMemorySchema,
  readMemorySchemaVersion,
  MEMORY_SCHEMA_VERSION,
  MemoryMigrationError
} from '@runtime/memory/schema/MemoryMigrations'

describe('memory schema 迁移', () => {
  let tempDir: string | null = null
  let db: BetterSqliteMemoryDb | null = null

  afterEach(() => {
    db?.close()
    db = null
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true })
      tempDir = null
    }
  })

  function newTempDbPath(): string {
    tempDir = mkdtempSync(join(tmpdir(), 'nova-mem-migration-'))
    return join(tempDir, 'memory.db')
  }

  /** 构造旧版本库：仅幂等建表（user_version=0）并写入 memory_files 数据 */
  function createLegacyDb(dbPath: string): void {
    const legacy = new BetterSqliteMemoryDb(dbPath)
    initMemorySchema(legacy)
    upsertIndexedFile(legacy, 'scopelegacy', {
      relPath: 'MEMORY.md',
      body: '旧库中的既有记忆正文，迁移后必须原样可检索。',
      fingerprint: '10-1',
      mtimeMs: 1,
      size: 10
    })
    legacy.close()
  }

  function schemaObjectNames(target: BetterSqliteMemoryDb): string[] {
    return target
      .prepare(`SELECT name FROM sqlite_master ORDER BY name`)
      .all<{ name: string }>()
      .map((r) => r.name)
  }

  it('旧库（user_version=0 + memory_files 数据）升级：旧数据无损、新表就位、版本到当前', () => {
    const dbPath = newTempDbPath()
    createLegacyDb(dbPath)

    db = openBetterSqliteMemoryDb(dbPath)

    expect(readMemorySchemaVersion(db)).toBe(MEMORY_SCHEMA_VERSION)

    const names = schemaObjectNames(db)
    expect(names).toContain('memory_records')
    expect(names).toContain('memory_evidence')
    expect(names).toContain('memory_record_fts')
    expect(names).toContain('memory_records_scope_status_idx')
    expect(names).toContain('memory_records_scope_key_idx')
    expect(names).toContain('memory_records_active_key_uidx')
    expect(names).toContain('memory_records_status_idx')
    expect(names).toContain('memory_records_updated_at_idx')
    expect(names).toContain('memory_records_fts_ai')
    expect(names).toContain('memory_records_fts_ad')
    expect(names).toContain('memory_records_fts_au')

    const hits = searchIndexed(db, 'scopelegacy', '既有记忆正文', 10)
    expect(hits).toHaveLength(1)
    expect(hits[0].relPath).toBe('MEMORY.md')
  })

  it('全新库直接迁移到当前版本，重复迁移幂等（无版本步重复执行）', () => {
    const dbPath = newTempDbPath()

    db = new BetterSqliteMemoryDb(dbPath)
    const first = migrateMemorySchema(db)
    expect(first.fromVersion).toBe(0)
    expect(first.appliedVersions).toEqual([1, 2])
    expect(readMemorySchemaVersion(db)).toBe(MEMORY_SCHEMA_VERSION)

    const second = migrateMemorySchema(db)
    expect(second.appliedVersions).toEqual([])
    expect(second.toVersion).toBe(MEMORY_SCHEMA_VERSION)

    // 重开入口同样幂等
    db.close()
    db = openBetterSqliteMemoryDb(dbPath)
    expect(readMemorySchemaVersion(db)).toBe(MEMORY_SCHEMA_VERSION)
  })

  it('v1 双 active keyed 记录升级时只保留最新 active，并建立唯一约束', () => {
    const dbPath = newTempDbPath()
    db = new BetterSqliteMemoryDb(dbPath)
    db.exec(`CREATE TABLE memory_records (
      id TEXT PRIMARY KEY,
      scope_kind TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      memory_key TEXT,
      content TEXT NOT NULL,
      status TEXT NOT NULL,
      confidence REAL NOT NULL,
      explicitness TEXT NOT NULL,
      source_type TEXT NOT NULL,
      valid_from INTEGER NOT NULL,
      valid_to INTEGER,
      supersedes_id TEXT,
      evidence_count INTEGER NOT NULL DEFAULT 1,
      distinct_session_count INTEGER NOT NULL DEFAULT 1,
      distinct_project_count INTEGER NOT NULL DEFAULT 1,
      source_path TEXT,
      source_fingerprint TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      metadata_json TEXT
    )`)
    db.exec(`INSERT INTO memory_records (
      id, scope_kind, scope_id, kind, memory_key, content, status, confidence,
      explicitness, source_type, valid_from, evidence_count, distinct_session_count,
      distinct_project_count, created_at, updated_at, last_seen_at
    ) VALUES
      ('mem_old', 'project', 'scope-a', 'project_fact', 'database.primary',
       '项目主数据库为 SQLite', 'active', 0.8, 'workspace_verified', 'workspace',
       1, 1, 1, 1, 1, 1, 1),
      ('mem_new', 'project', 'scope-a', 'project_fact', 'database.primary',
       '项目主数据库为 PostgreSQL', 'active', 0.9, 'workspace_verified', 'workspace',
       2, 1, 1, 1, 2, 2, 2)
    `)
    db.exec('PRAGMA user_version = 1')

    const result = migrateMemorySchema(db)
    expect(result.appliedVersions).toEqual([2])
    expect(readMemorySchemaVersion(db)).toBe(MEMORY_SCHEMA_VERSION)

    const rows = db.prepare(
      `SELECT id, status FROM memory_records ORDER BY id`
    ).all<{ id: string; status: string }>()
    expect(rows).toEqual([
      { id: 'mem_new', status: 'active' },
      { id: 'mem_old', status: 'needs_verification' }
    ])

    expect(() =>
      db!.exec(`INSERT INTO memory_records (
        id, scope_kind, scope_id, kind, memory_key, content, status, confidence,
        explicitness, source_type, valid_from, evidence_count, distinct_session_count,
        distinct_project_count, created_at, updated_at, last_seen_at
      ) VALUES (
        'mem_dup', 'project', 'scope-a', 'project_fact', 'database.primary',
        '项目主数据库为 MySQL', 'active', 0.7, 'workspace_verified', 'workspace',
        3, 1, 1, 1, 3, 3, 3
      )`)
    ).toThrow()
  })

  it('迁移中途失败整体回滚：旧数据保留、版本不变、半成品对象不残留', () => {
    const dbPath = newTempDbPath()
    createLegacyDb(dbPath)

    db = new BetterSqliteMemoryDb(dbPath)
    // 占用 memory_records 表名且缺少索引所需列，迫使版本步在索引 DDL 处失败
    db.exec(`CREATE TABLE memory_records (id TEXT PRIMARY KEY, only_col TEXT)`)

    let caught: MemoryMigrationError | null = null
    try {
      migrateMemorySchema(db)
    } catch (err) {
      caught = err instanceof MemoryMigrationError ? err : null
      if (!caught) {
        throw err
      }
    }

    expect(caught?.diagnostic.code).toBe('step-failed')
    expect(caught?.diagnostic.failedStep).toBe(1)
    expect(readMemorySchemaVersion(db)).toBe(0)

    const names = schemaObjectNames(db)
    expect(names).not.toContain('memory_evidence')
    expect(names).not.toContain('memory_record_fts')

    const hits = searchIndexed(db, 'scopelegacy', '既有记忆正文', 10)
    expect(hits).toHaveLength(1)
  })

  it('库版本高于当前支持时 fail-closed，不做降级迁移', () => {
    const dbPath = newTempDbPath()
    db = new BetterSqliteMemoryDb(dbPath)
    db.exec(`PRAGMA user_version = ${MEMORY_SCHEMA_VERSION + 1}`)

    let caught: MemoryMigrationError | null = null
    try {
      migrateMemorySchema(db)
    } catch (err) {
      caught = err instanceof MemoryMigrationError ? err : null
      if (!caught) {
        throw err
      }
    }

    expect(caught?.diagnostic.code).toBe('newer-version')
    expect(readMemorySchemaVersion(db)).toBe(MEMORY_SCHEMA_VERSION + 1)

    // 打开入口同样抛出（fail-soft 由宿主处理）
    db.close()
    db = null
    expect(() => openBetterSqliteMemoryDb(dbPath)).toThrow(MemoryMigrationError)
  })
})
