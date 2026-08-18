/**
 * memory.db schema 迁移入口：以 PRAGMA user_version 为唯一版本真源。
 * document 表（memory_files/memory_fts）保持无版本幂等 DDL（兼容旧库），由 initMemorySchema 负责；
 * 结构化表（memory_records/memory_evidence/memory_record_fts）按版本步进迁移。
 * 每个版本步在单事务内执行并写入新 user_version；失败整体回滚并抛 MemoryMigrationError，
 * fail-soft 由宿主决定（本层不吞错、不重试、绝不删库）。
 */
import type { MemoryDb } from '../MemoryDb'
import { initMemorySchema } from '../MemorySchema'

export const MEMORY_SCHEMA_VERSION = 2

export type MemoryMigrationFailureCode = 'newer-version' | 'step-failed'

/** 迁移失败诊断（供宿主日志 / fail-soft 决策，不含任何用户正文） */
export interface MemoryMigrationDiagnostic {
  code: MemoryMigrationFailureCode
  fromVersion: number
  targetVersion: number
  failedStep: number | null
  failedStatement: string | null
  message: string
}

export class MemoryMigrationError extends Error {
  readonly diagnostic: MemoryMigrationDiagnostic

  constructor(diagnostic: MemoryMigrationDiagnostic) {
    super(diagnostic.message)
    this.name = 'MemoryMigrationError'
    this.diagnostic = diagnostic
  }
}

export interface MemoryMigrationResult {
  fromVersion: number
  toVersion: number
  /** 本次实际应用的版本步；重复迁移时为空 */
  appliedVersions: readonly number[]
}

interface MemoryMigrationStep {
  version: number
  statements: readonly string[]
}

/**
 * 结构化长期记忆三表。约束：
 * - memory_records 的 id 是 TEXT 主键，FTS external content 依赖隐式 rowid 做行关联；
 *   禁止对该表执行 VACUUM（会重排无显式 INTEGER 主键表的 rowid，破坏 FTS 关联），
 *   索引失配时用 INSERT INTO memory_record_fts(memory_record_fts) VALUES('rebuild') 重建。
 * - 更新触发器对任何列变更都做 delete+insert 重写 FTS 行：status 虽是 UNINDEXED 列，
 *   external content 模式下 FTS 读取过滤值来自内容表，必须保证行同步而非只改索引。
 */
const V1_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS memory_records (
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
)`,
  `CREATE TABLE IF NOT EXISTS memory_evidence (
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL,
  session_id TEXT,
  message_id TEXT,
  project_scope_id TEXT,
  evidence_type TEXT NOT NULL,
  excerpt TEXT,
  created_at INTEGER NOT NULL
)`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS memory_record_fts USING fts5(
  content,
  memory_key,
  scope_kind UNINDEXED,
  scope_id UNINDEXED,
  status UNINDEXED,
  content='memory_records',
  content_rowid='rowid',
  tokenize='trigram'
)`,
  `CREATE INDEX IF NOT EXISTS memory_records_scope_status_idx
  ON memory_records(scope_kind, scope_id, status)`,
  `CREATE INDEX IF NOT EXISTS memory_records_scope_key_idx
  ON memory_records(scope_kind, scope_id, kind, memory_key, status)`,
  `CREATE INDEX IF NOT EXISTS memory_records_status_idx ON memory_records(status)`,
  `CREATE INDEX IF NOT EXISTS memory_records_updated_at_idx ON memory_records(updated_at)`,
  `CREATE INDEX IF NOT EXISTS memory_evidence_memory_id_idx ON memory_evidence(memory_id)`,
  `CREATE TRIGGER IF NOT EXISTS memory_records_fts_ai AFTER INSERT ON memory_records BEGIN
  INSERT INTO memory_record_fts(rowid, content, memory_key, scope_kind, scope_id, status)
  VALUES (new.rowid, new.content, new.memory_key, new.scope_kind, new.scope_id, new.status);
END`,
  `CREATE TRIGGER IF NOT EXISTS memory_records_fts_ad AFTER DELETE ON memory_records BEGIN
  INSERT INTO memory_record_fts(memory_record_fts, rowid, content, memory_key, scope_kind, scope_id, status)
  VALUES ('delete', old.rowid, old.content, old.memory_key, old.scope_kind, old.scope_id, old.status);
END`,
  `CREATE TRIGGER IF NOT EXISTS memory_records_fts_au AFTER UPDATE ON memory_records BEGIN
  INSERT INTO memory_record_fts(memory_record_fts, rowid, content, memory_key, scope_kind, scope_id, status)
  VALUES ('delete', old.rowid, old.content, old.memory_key, old.scope_kind, old.scope_id, old.status);
  INSERT INTO memory_record_fts(rowid, content, memory_key, scope_kind, scope_id, status)
  VALUES (new.rowid, new.content, new.memory_key, new.scope_kind, new.scope_id, new.status);
END`
]

const ACTIVE_KEY_UNIQUE_INDEX = 'memory_records_active_key_uidx'

const V2_STATEMENTS: readonly string[] = [
  `WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY scope_kind, scope_id, kind, memory_key
      ORDER BY updated_at DESC, last_seen_at DESC, created_at DESC, id ASC
    ) AS rn
  FROM memory_records
  WHERE status = 'active' AND memory_key IS NOT NULL
)
UPDATE memory_records
SET
  status = 'needs_verification',
  valid_to = COALESCE(valid_to, CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE id IN (SELECT id FROM ranked WHERE rn > 1)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ${ACTIVE_KEY_UNIQUE_INDEX}
  ON memory_records(scope_kind, scope_id, kind, memory_key)
  WHERE status = 'active' AND memory_key IS NOT NULL`
]

const MIGRATION_STEPS: readonly MemoryMigrationStep[] = [
  { version: 1, statements: V1_STATEMENTS },
  { version: 2, statements: V2_STATEMENTS }
]

export function readMemorySchemaVersion(db: MemoryDb): number {
  const row = db.prepare('PRAGMA user_version').get<{ user_version: number }>()
  return row?.user_version ?? 0
}

/**
 * 将 memory.db 迁移到 MEMORY_SCHEMA_VERSION（幂等；可从旧无版本库无损升级）。
 * @throws MemoryMigrationError 迁移失败（已回滚，旧数据不变）或库版本高于当前支持
 */
export function migrateMemorySchema(db: MemoryDb): MemoryMigrationResult {
  // 先保证 document 基线存在：全新库直接具备 memory_files/memory_fts，旧库幂等无操作
  initMemorySchema(db)

  const fromVersion = readMemorySchemaVersion(db)
  if (fromVersion > MEMORY_SCHEMA_VERSION) {
    throw new MemoryMigrationError({
      code: 'newer-version',
      fromVersion,
      targetVersion: MEMORY_SCHEMA_VERSION,
      failedStep: null,
      failedStatement: null,
      message: `memory.db user_version ${fromVersion} 高于当前支持的 ${MEMORY_SCHEMA_VERSION}，拒绝降级打开`
    })
  }

  const applied: number[] = []
  for (const step of MIGRATION_STEPS) {
    if (step.version <= fromVersion) {
      continue
    }
    applyStep(db, step, fromVersion)
    applied.push(step.version)
  }

  return {
    fromVersion,
    toVersion: readMemorySchemaVersion(db),
    appliedVersions: applied
  }
}

function applyStep(db: MemoryDb, step: MemoryMigrationStep, baseVersion: number): void {
  db.exec('BEGIN IMMEDIATE')
  try {
    for (const statement of step.statements) {
      try {
        db.exec(statement)
      } catch (err) {
        throw new MemoryMigrationError({
          code: 'step-failed',
          fromVersion: baseVersion,
          targetVersion: MEMORY_SCHEMA_VERSION,
          failedStep: step.version,
          failedStatement: statement.slice(0, 120),
          message: `memory.db 迁移到 v${step.version} 失败（已回滚）：${
            err instanceof Error ? err.message : String(err)
          }`
        })
      }
    }
    // user_version 写入必须在事务内：失败时版本号与 DDL 一起回滚
    db.exec(`PRAGMA user_version = ${step.version}`)
    db.exec('COMMIT')
  } catch (err) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // 事务已被底层错误中断时忽略二次失败，保留原始错误
    }
    throw err
  }
}
