import type Database from 'better-sqlite3'
import { EMPTY_CODE_INDEX_COVERAGE, type CodeIndexCoverage } from '../types'

export function readCodeGraphCoverage(
  db: Database.Database,
  generation: number | null
): CodeIndexCoverage {
  if (generation === null) return EMPTY_CODE_INDEX_COVERAGE
  if (!Number.isInteger(generation) || generation < 1) {
    throw new Error('Code Graph coverage generation 无效')
  }
  const files = db.prepare(
    `SELECT COUNT(*) AS totalFiles,
            COALESCE(SUM(parse_status = 'parsed'), 0) AS indexedFiles,
            COALESCE(SUM(parse_status = 'failed'), 0) AS parseFailures,
            COALESCE(SUM(parse_status = 'unsupported'), 0) AS unsupportedFiles,
            COALESCE(SUM(parse_status = 'skipped_too_large'), 0) AS oversizedFiles
     FROM files WHERE generation = ?`
  ).get(generation)
  const unresolved = db.prepare(
    `SELECT COUNT(*) AS unresolvedRelations
     FROM unresolved_relations WHERE generation = ?`
  ).get(generation)
  const unsupportedFiles = readNumber(files, 'unsupportedFiles')
  return Object.freeze({
    eligibleFiles: readNumber(files, 'totalFiles') - unsupportedFiles,
    indexedFiles: readNumber(files, 'indexedFiles'),
    parseFailures: readNumber(files, 'parseFailures'),
    unsupportedFiles,
    oversizedFiles: readNumber(files, 'oversizedFiles'),
    unresolvedRelations: readNumber(unresolved, 'unresolvedRelations')
  })
}

function readNumber(row: unknown, key: string): number {
  if (typeof row !== 'object' || row === null || Array.isArray(row)) {
    throw new Error('Code Graph coverage 返回了无效数据')
  }
  const value = Reflect.get(row, key)
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Code Graph coverage 字段 ${key} 不是有限数字`)
  }
  return value
}
