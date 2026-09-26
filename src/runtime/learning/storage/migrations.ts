import type BetterSqlite3 from 'better-sqlite3'
import {
  CURRENT_LEARNING_SCHEMA_VERSION,
  LEARNING_SCHEMA_META_KEY,
  learningSchemaV1Statements,
  learningSchemaV2Statements,
  learningSchemaV3Statements,
  learningSchemaV4Statements,
  learningSchemaV5Statements
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

/** 每个版本的迁移语句；版本号即升级后的 schema 版本。 */
const SCHEMA_VERSION_STEPS: readonly {
  readonly version: number
  readonly statements: () => readonly string[]
}[] = [
  { version: 2, statements: learningSchemaV2Statements },
  { version: 3, statements: learningSchemaV3Statements },
  { version: 4, statements: learningSchemaV4Statements },
  { version: 5, statements: learningSchemaV5Statements }
]

function setStoredVersion(db: BetterSqlite3.Database, version: number): void {
  db.prepare(
    `INSERT INTO schema_meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(LEARNING_SCHEMA_META_KEY, String(version))
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
    for (const step of SCHEMA_VERSION_STEPS) {
      if (step.version > CURRENT_LEARNING_SCHEMA_VERSION) continue
      for (const sql of step.statements()) {
        db.exec(sql)
      }
    }
    setStoredVersion(db, CURRENT_LEARNING_SCHEMA_VERSION)
  })

  const applyStep = (version: number, statements: () => readonly string[]) =>
    db.transaction(() => {
      for (const sql of statements()) {
        db.exec(sql)
      }
      setStoredVersion(db, version)
    })

  if (stored === 0) {
    applyFresh()
    return
  }
  // 旧库逐版本升级；每步独立事务，任一步失败不留下半迁移状态
  for (const step of SCHEMA_VERSION_STEPS) {
    if (step.version <= stored || step.version > CURRENT_LEARNING_SCHEMA_VERSION) continue
    applyStep(step.version, step.statements)()
  }
}

export function assertLearningDatabaseWritable(db: BetterSqlite3.Database): void {
  const stored = readStoredVersion(db)
  if (stored > CURRENT_LEARNING_SCHEMA_VERSION) {
    throw new LearningSchemaFutureError(stored)
  }
}
