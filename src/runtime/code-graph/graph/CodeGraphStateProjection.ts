import type Database from 'better-sqlite3'
import type { CodeGraphMetadata } from './CodeGraphRepository'

export function readCodeGraphMetadata(db: Database.Database): CodeGraphMetadata {
  const row = db.prepare(
    `SELECT
      schema_version AS schemaVersion,
      workspace_identity AS workspaceIdentity,
      active_generation AS activeGeneration,
      revision,
      parser_signature AS parserSignature,
      resolver_signature AS resolverSignature,
      last_completed_at AS lastCompletedAt,
      last_accessed AS lastAccessed
     FROM index_meta WHERE singleton = 1`
  ).get()
  return Object.freeze({
    schemaVersion: readNumber(row, 'schemaVersion'),
    workspaceIdentity: readString(row, 'workspaceIdentity'),
    activeGeneration: readNullableNumber(row, 'activeGeneration'),
    revision: readNumber(row, 'revision'),
    parserSignature: readString(row, 'parserSignature'),
    resolverSignature: readString(row, 'resolverSignature'),
    lastCompletedAt: readNullableNumber(row, 'lastCompletedAt'),
    lastAccessed: readNumber(row, 'lastAccessed')
  })
}

export function readNextCodeGraphGeneration(db: Database.Database): number {
  const row = db.prepare(
    `SELECT COALESCE(MAX(generation), 0) + 1 AS nextGeneration FROM generations`
  ).get()
  const next = readNumber(row, 'nextGeneration')
  if (!Number.isInteger(next) || next < 1) {
    throw new Error('Code Graph nextGeneration 无效')
  }
  return next
}

function readNumber(row: unknown, key: string): number {
  const value = readField(row, key)
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Code Graph 状态字段 ${key} 不是有限数字`)
  }
  return value
}

function readNullableNumber(row: unknown, key: string): number | null {
  const value = readField(row, key)
  if (value === null) return null
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Code Graph 状态字段 ${key} 不是可空数字`)
  }
  return value
}

function readString(row: unknown, key: string): string {
  const value = readField(row, key)
  if (typeof value !== 'string') {
    throw new Error(`Code Graph 状态字段 ${key} 不是字符串`)
  }
  return value
}

function readField(row: unknown, key: string): unknown {
  if (typeof row !== 'object' || row === null || Array.isArray(row)) {
    throw new Error('Code Graph 状态查询返回了无效数据')
  }
  return Reflect.get(row, key)
}
