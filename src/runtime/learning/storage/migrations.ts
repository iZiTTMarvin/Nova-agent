import type BetterSqlite3 from 'better-sqlite3'
import {
  CURRENT_LEARNING_SCHEMA_VERSION,
  LEARNING_SCHEMA_META_KEY,
  learningSchemaV1Statements,
  learningSchemaV2Statements,
  learningSchemaV3Statements
} from './schema'

export { CURRENT_LEARNING_SCHEMA_VERSION, LEARNING_SCHEMA_META_KEY } from './schema'

export class LearningSchemaFutureError extends Error {
  readonly storedVersion: number
  constructor(storedVersion: number) {
    super(
      `学习 schemaVersion ${storedVersion} 高于当前支持的 ${CURRENT_LEARNING_SCHEMA_VERSION}，拒绝写入`
    )
    this.name = 'LearningSchemaFutureError'
    this.storedVersion = storedVersion
  }
}

function readStoredVersion(db: BetterSqlite3.Database): number {
  const row = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='schema_meta'`
    )
    .get() as { name?: string } | undefined
  if (!row?.name) return 0
  const meta = db
    .prepare(`SELECT value FROM schema_meta WHERE key = ?`)
    .get(LEARNING_SCHEMA_META_KEY) as { value?: string } | undefined
  if (!meta?.value) return 0
  const parsed = Number.parseInt(meta.value, 10)
  return Number.isFinite(parsed) ? parsed : 0
}

export function migrateLearningDatabase(db: BetterSqlite3.Database): void {
  const stored = readStoredVersion(db)
  if (stored > CURRENT_LEARNING_SCHEMA_VERSION) {
    throw new LearningSchemaFutureError(stored)
  }
  if (stored === CURRENT_LEARNING_SCHEMA_VERSION) {
    return
  }

  const applyFresh = db.transaction(() => {
    for (const sql of learningSchemaV1Statements()) {
      db.exec(sql)
    }
    for (const sql of learningSchemaV2Statements()) {
      db.exec(sql)
    }
    for (const sql of learningSchemaV3Statements()) {
      db.exec(sql)
    }
    db.prepare(
      `INSERT INTO schema_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run(LEARNING_SCHEMA_META_KEY, String(CURRENT_LEARNING_SCHEMA_VERSION))
  })

  const applyV2 = db.transaction(() => {
    for (const sql of learningSchemaV2Statements()) {
      db.exec(sql)
    }
    db.prepare(
      `INSERT INTO schema_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run(LEARNING_SCHEMA_META_KEY, '2')
  })

  const applyV3 = db.transaction(() => {
    for (const sql of learningSchemaV3Statements()) {
      db.exec(sql)
    }
    db.prepare(
      `INSERT INTO schema_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run(LEARNING_SCHEMA_META_KEY, String(CURRENT_LEARNING_SCHEMA_VERSION))
  })

  if (stored === 0) {
    applyFresh()
    return
  }
  if (stored === 1 && CURRENT_LEARNING_SCHEMA_VERSION >= 2) {
    applyV2()
    if (CURRENT_LEARNING_SCHEMA_VERSION >= 3) {
      applyV3()
    }
    return
  }
  if (stored === 2 && CURRENT_LEARNING_SCHEMA_VERSION === 3) {
    applyV3()
    return
  }
  throw new Error(`不支持的学习 schema 中间版本 ${stored}`)
}

export function assertLearningDatabaseWritable(db: BetterSqlite3.Database): void {
  const stored = readStoredVersion(db)
  if (stored > CURRENT_LEARNING_SCHEMA_VERSION) {
    throw new LearningSchemaFutureError(stored)
  }
}
