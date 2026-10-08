import type { MemoryDb } from '../MemoryDb'
import { initMemorySchema } from '../MemorySchema'
import { MEMORY_INDEX_SCHEMA } from '../index/MemoryIndex'

export const MEMORY_SCHEMA_VERSION = 3
export type MemoryMigrationFailureCode = 'newer-version' | 'step-failed'
export interface MemoryMigrationDiagnostic {
  code: MemoryMigrationFailureCode
  fromVersion: number
  targetVersion: number
  failedStep: number | null
  failedStatement: string | null
  message: string
}
export class MemoryMigrationError extends Error {
  constructor(readonly diagnostic: MemoryMigrationDiagnostic) {
    super(diagnostic.message)
    this.name = 'MemoryMigrationError'
  }
}
export interface MemoryMigrationResult {
  fromVersion: number
  toVersion: number
  appliedVersions: readonly number[]
}
export function readMemorySchemaVersion(db: MemoryDb): number {
  return db.prepare('PRAGMA user_version').get<{ user_version: number }>()?.user_version ?? 0
}
export function hasLegacyMemoryRecords(db: MemoryDb): boolean {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_records'").get()
}

// Legacy structured tables remain authoritative until their file export is validated.
export function migrateMemorySchema(db: MemoryDb): MemoryMigrationResult {
  const fromVersion = readMemorySchemaVersion(db)
  if (fromVersion > MEMORY_SCHEMA_VERSION) throw new MemoryMigrationError({
    code: 'newer-version', fromVersion, targetVersion: MEMORY_SCHEMA_VERSION,
    failedStep: null, failedStatement: null, message: 'Memory database version is newer than supported'
  })
  initMemorySchema(db)
  db.exec('BEGIN IMMEDIATE')
  try {
    db.exec(MEMORY_INDEX_SCHEMA)
    if (!hasLegacyMemoryRecords(db)) db.exec(`PRAGMA user_version = ${MEMORY_SCHEMA_VERSION}`)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw new MemoryMigrationError({
      code: 'step-failed', fromVersion, targetVersion: MEMORY_SCHEMA_VERSION,
      failedStep: MEMORY_SCHEMA_VERSION, failedStatement: null,
      message: error instanceof Error ? error.message : 'Memory schema initialization failed'
    })
  }
  const toVersion = readMemorySchemaVersion(db)
  return { fromVersion, toVersion, appliedVersions: toVersion !== fromVersion ? [toVersion] : [] }
}
