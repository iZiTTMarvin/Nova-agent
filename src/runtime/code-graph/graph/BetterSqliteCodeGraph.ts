import * as fs from 'node:fs'
import * as path from 'node:path'
import Database from 'better-sqlite3'
import {
  type CodeIndexCoverage,
  type CodeIndexOperation
} from '../types'
import type {
  CodeGraphFileInput,
  CodeGraphFileRecord,
  CodeGraphGenerationActivation,
  CodeGraphGenerationInput,
  CodeGraphIncrementalUpdate,
  CodeGraphMetadata,
  CodeGraphRepository,
  CodeGraphSymbolInput
} from './CodeGraphRepository'
import {
  CODE_GRAPH_SCHEMA_VERSION,
  migrateCodeGraphSchema
} from './schema/CodeGraphMigrations'
import { readCodeGraphCoverage } from './CodeGraphCoverage'
import {
  readCodeGraphMetadata,
  readNextCodeGraphGeneration
} from './CodeGraphStateProjection'

export const CODE_GRAPH_DB_FILE = 'index.db'
export const CODE_GRAPH_DOC_EXCERPT_MAX_CHARS = 512

export interface BetterSqliteCodeGraphOptions {
  readonly dbPath: string
  readonly workspaceIdentity: string
  readonly parserSignature: string
  readonly resolverSignature: string
  readonly now?: () => number
}

/** SQLite 适配器独占 schema、事务与 write fence，不承担索引调度策略。 */
export class BetterSqliteCodeGraph implements CodeGraphRepository {
  private constructor(
    private readonly db: Database.Database,
    private readonly workspaceIdentity: string
  ) {}

  static open(options: BetterSqliteCodeGraphOptions): BetterSqliteCodeGraph {
    assertNonEmpty(options.workspaceIdentity, 'workspaceIdentity')
    assertNonEmpty(options.parserSignature, 'parserSignature')
    assertNonEmpty(options.resolverSignature, 'resolverSignature')
    fs.mkdirSync(path.dirname(options.dbPath), { recursive: true })

    const db = new Database(options.dbPath)
    try {
      db.pragma('journal_mode = WAL')
      db.pragma('synchronous = NORMAL')
      db.pragma('foreign_keys = ON')
      db.pragma('busy_timeout = 5000')
      migrateCodeGraphSchema(db)

      const now = (options.now ?? Date.now)()
      db.prepare(
        `INSERT OR IGNORE INTO index_meta (
          singleton, schema_version, workspace_identity, active_generation, revision,
          parser_signature, resolver_signature, last_completed_at, last_accessed
        ) VALUES (1, ?, ?, NULL, 0, ?, ?, NULL, ?)`
      ).run(
        CODE_GRAPH_SCHEMA_VERSION,
        options.workspaceIdentity,
        options.parserSignature,
        options.resolverSignature,
        now
      )

      const repository = new BetterSqliteCodeGraph(db, options.workspaceIdentity)
      const metadata = repository.readMetadata()
      if (metadata.workspaceIdentity !== options.workspaceIdentity) {
        throw new Error(
          `Code Graph workspace identity 不匹配：${metadata.workspaceIdentity}`
        )
      }
      if (metadata.schemaVersion !== CODE_GRAPH_SCHEMA_VERSION) {
        throw new Error(
          `Code Graph index_meta schema ${metadata.schemaVersion} 与当前版本不一致`
        )
      }
      return repository
    } catch (error) {
      db.close()
      throw error
    }
  }

  async getMetadata(): Promise<CodeGraphMetadata> {
    return this.readMetadata()
  }

  async nextGeneration(): Promise<number> {
    return readNextCodeGraphGeneration(this.db)
  }

  async claimOperation(operation: CodeIndexOperation): Promise<void> {
    assertNonEmpty(operation.operationId, 'operationId')
    this.assertWorkspaceIdentity(operation.workspaceIdentity)
    assertPositiveInteger(operation.generation, 'generation')
    assertNonNegativeInteger(operation.baseRevision, 'baseRevision')
    this.inTransaction(() => {
      const metadata = this.readMetadata()
      assertExpectedSnapshot(
        metadata,
        operation.baseGeneration,
        operation.baseRevision
      )
      const result = this.db.prepare(
        `UPDATE index_meta
         SET write_operation_id = ?, write_operation_kind = ?, write_generation = ?,
             write_base_generation = ?, write_base_revision = ?
         WHERE singleton = 1 AND workspace_identity = ?
           AND active_generation IS ? AND revision = ?`
      ).run(
        operation.operationId,
        operation.kind,
        operation.generation,
        operation.baseGeneration,
        operation.baseRevision,
        operation.workspaceIdentity,
        operation.baseGeneration,
        operation.baseRevision
      )
      if (result.changes !== 1) throw new Error('Code Graph operation 基线已失效')
    })
  }

  async releaseOperation(operation: CodeIndexOperation): Promise<void> {
    this.assertWorkspaceIdentity(operation.workspaceIdentity)
    this.db.prepare(
      `UPDATE index_meta
       SET write_operation_id = NULL, write_operation_kind = NULL,
           write_generation = NULL, write_base_generation = NULL,
           write_base_revision = NULL
       WHERE singleton = 1 AND write_operation_id = ?
         AND write_operation_kind = ? AND write_generation = ?
         AND write_base_generation IS ? AND write_base_revision = ?`
    ).run(
      operation.operationId,
      operation.kind,
      operation.generation,
      operation.baseGeneration,
      operation.baseRevision
    )
  }

  async getCoverage(generation?: number | null): Promise<CodeIndexCoverage> {
    const targetGeneration = generation === undefined
      ? this.readMetadata().activeGeneration
      : generation
    return readCodeGraphCoverage(this.db, targetGeneration)
  }

  async findActiveFile(filePath: string): Promise<CodeGraphFileRecord | null> {
    assertWorkspacePath(filePath)
    const row = this.db.prepare(
      `SELECT
        f.id,
        f.generation,
        f.path,
        f.language,
        f.content_hash AS contentHash,
        f.size_bytes AS sizeBytes,
        f.mtime_ms AS mtimeMs,
        f.line_count AS lineCount,
        f.parse_status AS parseStatus
       FROM files f
       JOIN index_meta m ON m.singleton = 1 AND m.active_generation = f.generation
       WHERE f.path = ?`
    ).get(filePath)
    return row === undefined ? null : parseFileRecord(row)
  }

  async stageGeneration(input: CodeGraphGenerationInput): Promise<void> {
    this.assertGenerationInput(input)
    const metadata = this.readMetadata()
    if (metadata.activeGeneration === input.generation) {
      throw new Error('不能覆盖 active generation')
    }

    this.inTransaction(() => {
      this.assertWriteFence({
        operationId: input.operationId,
        kind: 'full-rebuild',
        generation: input.generation
      })
      this.deleteGenerationRows(input.generation)
      this.db.prepare(
        `INSERT INTO generations (
          generation, operation_id, workspace_identity, parser_signature, resolver_signature, staged_at
        ) VALUES (?, ?, ?, ?, ?, ?)`
      ).run(
        input.generation,
        input.operationId,
        this.workspaceIdentity,
        input.parserSignature,
        input.resolverSignature,
        input.stagedAt
      )
      this.insertGraphRows(input.generation, input)
    })
  }

  async activateGeneration(input: CodeGraphGenerationActivation): Promise<CodeGraphMetadata> {
    assertNonEmpty(input.operationId, 'operationId')
    this.assertWorkspaceIdentity(input.workspaceIdentity)
    assertPositiveInteger(input.generation, 'generation')
    assertNonNegativeInteger(input.expectedRevision, 'expectedRevision')

    this.inTransaction(() => {
      const metadata = this.readMetadata()
      assertExpectedSnapshot(
        metadata,
        input.expectedActiveGeneration,
        input.expectedRevision
      )
      this.assertWriteFence({
        operationId: input.operationId,
        kind: 'full-rebuild',
        generation: input.generation,
        baseGeneration: input.expectedActiveGeneration,
        baseRevision: input.expectedRevision
      })

      const manifest = this.db.prepare(
        `SELECT operation_id AS operationId,
                workspace_identity AS workspaceIdentity,
                parser_signature AS parserSignature,
                resolver_signature AS resolverSignature
         FROM generations WHERE generation = ?`
      ).get(input.generation)
      const manifestIdentity = readString(manifest, 'workspaceIdentity')
      if (manifestIdentity !== this.workspaceIdentity) {
        throw new Error('staged generation 属于其他 workspace')
      }
      if (readString(manifest, 'operationId') !== input.operationId) {
        throw new Error('staged generation operation 已失效')
      }

      const result = this.db.prepare(
        `UPDATE index_meta
         SET active_generation = ?, revision = revision + 1,
             parser_signature = ?, resolver_signature = ?, last_completed_at = ?,
             write_operation_id = NULL, write_operation_kind = NULL,
             write_generation = NULL, write_base_generation = NULL,
             write_base_revision = NULL
         WHERE singleton = 1 AND revision = ? AND active_generation IS ?
           AND write_operation_id = ?`
      ).run(
        input.generation,
        readString(manifest, 'parserSignature'),
        readString(manifest, 'resolverSignature'),
        input.completedAt,
        input.expectedRevision,
        input.expectedActiveGeneration,
        input.operationId
      )
      if (result.changes !== 1) {
        throw new Error('Code Graph generation 激活时快照已变化')
      }
    })
    return this.readMetadata()
  }

  async applyIncrementalUpdate(input: CodeGraphIncrementalUpdate): Promise<CodeGraphMetadata> {
    assertNonEmpty(input.operationId, 'operationId')
    this.assertWorkspaceIdentity(input.workspaceIdentity)
    assertPositiveInteger(input.generation, 'generation')
    assertNonNegativeInteger(input.expectedRevision, 'expectedRevision')
    this.assertGraphRows(input)

    this.inTransaction(() => {
      const metadata = this.readMetadata()
      assertExpectedSnapshot(metadata, input.generation, input.expectedRevision)
      this.assertWriteFence({
        operationId: input.operationId,
        kind: 'incremental-update',
        generation: input.generation,
        baseGeneration: input.generation,
        baseRevision: input.expectedRevision
      })

      const affectedPaths = new Set<string>()
      for (const filePath of input.removedPaths) {
        assertWorkspacePath(filePath)
        affectedPaths.add(filePath)
      }
      for (const file of input.files) affectedPaths.add(file.path)

      const deleteFts = this.db.prepare(
        `DELETE FROM symbol_fts WHERE generation = ? AND path = ?`
      )
      const deleteFile = this.db.prepare(
        `DELETE FROM files WHERE generation = ? AND path = ?`
      )
      for (const filePath of affectedPaths) {
        deleteFts.run(input.generation, filePath)
        deleteFile.run(input.generation, filePath)
      }

      this.insertGraphRows(input.generation, input)
      const result = this.db.prepare(
        `UPDATE index_meta
         SET revision = revision + 1, last_completed_at = ?,
             write_operation_id = NULL, write_operation_kind = NULL,
             write_generation = NULL, write_base_generation = NULL,
             write_base_revision = NULL
         WHERE singleton = 1 AND workspace_identity = ?
           AND active_generation = ? AND revision = ?
           AND write_operation_id = ?`
      ).run(
        input.completedAt,
        input.workspaceIdentity,
        input.generation,
        input.expectedRevision,
        input.operationId
      )
      if (result.changes !== 1) {
        throw new Error('Code Graph 增量提交时快照已变化')
      }
    })
    return this.readMetadata()
  }

  async deleteGeneration(generation: number): Promise<void> {
    assertPositiveInteger(generation, 'generation')
    if (this.readMetadata().activeGeneration === generation) {
      throw new Error('不能删除 active generation')
    }
    this.inTransaction(() => this.deleteGenerationRows(generation))
  }

  async touchAccess(accessedAt: number): Promise<void> {
    assertFiniteNumber(accessedAt, 'accessedAt')
    this.db.prepare(
      `UPDATE index_meta SET last_accessed = ? WHERE singleton = 1`
    ).run(accessedAt)
  }

  async close(): Promise<void> {
    try {
      this.db.pragma('wal_checkpoint(TRUNCATE)')
    } finally {
      this.db.close()
    }
  }

  private readMetadata(): CodeGraphMetadata {
    return readCodeGraphMetadata(this.db)
  }

  private assertGenerationInput(input: CodeGraphGenerationInput): void {
    assertNonEmpty(input.operationId, 'operationId')
    assertPositiveInteger(input.generation, 'generation')
    assertNonEmpty(input.parserSignature, 'parserSignature')
    assertNonEmpty(input.resolverSignature, 'resolverSignature')
    assertFiniteNumber(input.stagedAt, 'stagedAt')
    this.assertGraphRows(input)
  }

  private assertGraphRows(input: Pick<
    CodeGraphGenerationInput,
    'files' | 'symbols' | 'fileEdges' | 'symbolEdges' | 'unresolvedRelations'
  >): void {
    const paths = new Set<string>()
    for (const file of input.files) {
      assertWorkspacePath(file.path)
      assertNonEmpty(file.contentHash, 'contentHash')
      assertNonNegativeInteger(file.sizeBytes, 'sizeBytes')
      assertFiniteNumber(file.mtimeMs, 'mtimeMs')
      assertNonNegativeInteger(file.lineCount, 'lineCount')
      if (paths.has(file.path)) throw new Error(`重复文件路径：${file.path}`)
      paths.add(file.path)
    }

    const symbolIds = new Set<string>()
    for (const symbol of input.symbols) {
      assertWorkspacePath(symbol.filePath)
      assertNonEmpty(symbol.stableId, 'stableId')
      assertNonEmpty(symbol.name, 'name')
      assertNonEmpty(symbol.qualifiedName, 'qualifiedName')
      assertPositiveInteger(symbol.startLine, 'startLine')
      assertPositiveInteger(symbol.endLine, 'endLine')
      assertNonNegativeInteger(symbol.startByte, 'startByte')
      assertNonNegativeInteger(symbol.endByte, 'endByte')
      if (symbol.endLine < symbol.startLine || symbol.endByte < symbol.startByte) {
        throw new Error(`符号范围无效：${symbol.stableId}`)
      }
      if (
        symbol.docExcerpt !== null &&
        symbol.docExcerpt.length > CODE_GRAPH_DOC_EXCERPT_MAX_CHARS
      ) {
        throw new Error(`符号摘要超过 ${CODE_GRAPH_DOC_EXCERPT_MAX_CHARS} 字符`)
      }
      if (symbolIds.has(symbol.stableId)) {
        throw new Error(`重复符号 stableId：${symbol.stableId}`)
      }
      symbolIds.add(symbol.stableId)
    }

    for (const edge of input.fileEdges) {
      assertWorkspacePath(edge.sourcePath)
      assertWorkspacePath(edge.targetPath)
      assertPositiveInteger(edge.sourceLine, 'sourceLine')
    }
    for (const edge of input.symbolEdges) {
      assertNonEmpty(edge.sourceSymbolId, 'sourceSymbolId')
      assertNonEmpty(edge.targetSymbolId, 'targetSymbolId')
      assertWorkspacePath(edge.sourceFile)
      assertPositiveInteger(edge.sourceLine, 'sourceLine')
    }
    for (const relation of input.unresolvedRelations) {
      assertWorkspacePath(relation.filePath)
      assertNonEmpty(relation.rawTarget, 'rawTarget')
      assertNonEmpty(relation.reason, 'reason')
      assertPositiveInteger(relation.sourceLine, 'sourceLine')
    }
  }

  private insertGraphRows(
    generation: number,
    input: Pick<
      CodeGraphGenerationInput,
      'files' | 'symbols' | 'fileEdges' | 'symbolEdges' | 'unresolvedRelations'
    >
  ): void {
    const insertFile = this.db.prepare(
      `INSERT INTO files (
        generation, path, language, content_hash, size_bytes, mtime_ms, line_count, parse_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    for (const file of input.files) {
      insertFile.run(
        generation,
        file.path,
        file.language,
        file.contentHash,
        file.sizeBytes,
        file.mtimeMs,
        file.lineCount,
        file.parseStatus
      )
    }

    const fileIds = this.loadFileIds(generation)
    const insertSymbol = this.db.prepare(
      `INSERT INTO symbols (
        generation, file_id, stable_id, name, qualified_name, kind, exported,
        signature, doc_excerpt, identifier_tokens, start_line, end_line, start_byte, end_byte
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    const insertFts = this.db.prepare(
      `INSERT INTO symbol_fts (
        symbol_id, generation, name, qualified_name, path, signature, short_doc, identifier_tokens
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    for (const symbol of input.symbols) {
      const fileId = requireMapValue(fileIds, symbol.filePath, 'symbol file')
      const result = insertSymbol.run(
        generation,
        fileId,
        symbol.stableId,
        symbol.name,
        symbol.qualifiedName,
        symbol.kind,
        symbol.exported ? 1 : 0,
        symbol.signature,
        symbol.docExcerpt,
        symbol.identifierTokens,
        symbol.startLine,
        symbol.endLine,
        symbol.startByte,
        symbol.endByte
      )
      insertFts.run(
        normalizeRowId(result.lastInsertRowid),
        generation,
        symbol.name,
        symbol.qualifiedName,
        symbol.filePath,
        symbol.signature,
        symbol.docExcerpt,
        symbol.identifierTokens
      )
    }

    const symbolIds = this.loadSymbolIds(generation)
    const insertFileEdge = this.db.prepare(
      `INSERT INTO file_edges (
        generation, source_file_id, target_file_id, kind, confidence, resolver, source_line
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    for (const edge of input.fileEdges) {
      insertFileEdge.run(
        generation,
        requireMapValue(fileIds, edge.sourcePath, 'file edge source'),
        requireMapValue(fileIds, edge.targetPath, 'file edge target'),
        edge.kind,
        edge.confidence,
        edge.resolver,
        edge.sourceLine
      )
    }

    const insertSymbolEdge = this.db.prepare(
      `INSERT INTO symbol_edges (
        generation, source_symbol_id, target_symbol_id, kind, confidence,
        resolver, source_file, source_line
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    for (const edge of input.symbolEdges) {
      insertSymbolEdge.run(
        generation,
        requireMapValue(symbolIds, edge.sourceSymbolId, 'symbol edge source'),
        requireMapValue(symbolIds, edge.targetSymbolId, 'symbol edge target'),
        edge.kind,
        edge.confidence,
        edge.resolver,
        edge.sourceFile,
        edge.sourceLine
      )
    }

    const insertUnresolved = this.db.prepare(
      `INSERT INTO unresolved_relations (
        generation, file_id, source_symbol_id, kind, raw_target,
        module_specifier, source_line, reason, resolver
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    for (const relation of input.unresolvedRelations) {
      insertUnresolved.run(
        generation,
        requireMapValue(fileIds, relation.filePath, 'unresolved file'),
        relation.sourceSymbolId === null
          ? null
          : requireMapValue(symbolIds, relation.sourceSymbolId, 'unresolved symbol'),
        relation.kind,
        relation.rawTarget,
        relation.moduleSpecifier,
        relation.sourceLine,
        relation.reason,
        relation.resolver
      )
    }
  }

  private loadFileIds(generation: number): Map<string, number> {
    const rows = this.db.prepare(
      `SELECT id, path FROM files WHERE generation = ?`
    ).all(generation)
    const ids = new Map<string, number>()
    for (const row of rows) ids.set(readString(row, 'path'), readNumber(row, 'id'))
    return ids
  }

  private loadSymbolIds(generation: number): Map<string, number> {
    const rows = this.db.prepare(
      `SELECT id, stable_id AS stableId FROM symbols WHERE generation = ?`
    ).all(generation)
    const ids = new Map<string, number>()
    for (const row of rows) ids.set(readString(row, 'stableId'), readNumber(row, 'id'))
    return ids
  }

  private deleteGenerationRows(generation: number): void {
    this.db.prepare(`DELETE FROM symbol_fts WHERE generation = ?`).run(generation)
    this.db.prepare(`DELETE FROM generations WHERE generation = ?`).run(generation)
  }

  private assertWorkspaceIdentity(workspaceIdentity: string): void {
    if (workspaceIdentity !== this.workspaceIdentity) {
      throw new Error('Code Graph operation workspace identity 已失效')
    }
  }

  private assertWriteFence(expected: {
    readonly operationId: string
    readonly kind: CodeIndexOperation['kind']
    readonly generation: number
    readonly baseGeneration?: number | null
    readonly baseRevision?: number
  }): void {
    const row = this.db.prepare(
      `SELECT
        write_operation_id AS operationId,
        write_operation_kind AS kind,
        write_generation AS generation,
        write_base_generation AS baseGeneration,
        write_base_revision AS baseRevision
       FROM index_meta WHERE singleton = 1`
    ).get()
    if (
      readNullableString(row, 'operationId') !== expected.operationId ||
      readNullableString(row, 'kind') !== expected.kind ||
      readNullableNumber(row, 'generation') !== expected.generation ||
      (expected.baseGeneration !== undefined &&
        readNullableNumber(row, 'baseGeneration') !== expected.baseGeneration) ||
      (expected.baseRevision !== undefined &&
        readNullableNumber(row, 'baseRevision') !== expected.baseRevision)
    ) {
      throw new Error('Code Graph operation write fence 已失效')
    }
  }

  private inTransaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = work()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // 保留原始事务错误。
      }
      throw error
    }
  }
}

export function openBetterSqliteCodeGraph(
  options: BetterSqliteCodeGraphOptions
): BetterSqliteCodeGraph {
  return BetterSqliteCodeGraph.open(options)
}

function parseFileRecord(row: unknown): CodeGraphFileRecord {
  const language = readString(row, 'language')
  const parseStatus = readString(row, 'parseStatus')
  if (!isGraphLanguage(language)) throw new Error(`未知代码语言：${language}`)
  if (!isParseStatus(parseStatus)) throw new Error(`未知解析状态：${parseStatus}`)
  return Object.freeze({
    id: readNumber(row, 'id'),
    generation: readNumber(row, 'generation'),
    path: readString(row, 'path'),
    language,
    contentHash: readString(row, 'contentHash'),
    sizeBytes: readNumber(row, 'sizeBytes'),
    mtimeMs: readNumber(row, 'mtimeMs'),
    lineCount: readNumber(row, 'lineCount'),
    parseStatus
  })
}

function assertExpectedSnapshot(
  metadata: CodeGraphMetadata,
  activeGeneration: number | null,
  revision: number
): void {
  if (
    metadata.activeGeneration !== activeGeneration ||
    metadata.revision !== revision
  ) {
    throw new Error('Code Graph operation 基线已失效')
  }
}

function assertWorkspacePath(filePath: string): void {
  assertNonEmpty(filePath, 'path')
  if (
    filePath.includes('\\') ||
    filePath.startsWith('/') ||
    filePath === '..' ||
    filePath.startsWith('../') ||
    filePath.includes('/../') ||
    path.posix.isAbsolute(filePath) ||
    path.posix.normalize(filePath) !== filePath
  ) {
    throw new Error(`Code Graph path 必须是规范化工作区相对路径：${filePath}`)
  }
}

function assertNonEmpty(value: string, field: string): void {
  if (value.length === 0) throw new Error(`Code Graph 字段 ${field} 不能为空`)
}

function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Code Graph 字段 ${field} 必须是正整数`)
  }
}

function assertNonNegativeInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Code Graph 字段 ${field} 必须是非负整数`)
  }
}

function assertFiniteNumber(value: number, field: string): void {
  if (!Number.isFinite(value)) {
    throw new Error(`Code Graph 字段 ${field} 必须是有限数值`)
  }
}

function normalizeRowId(value: number | bigint): number {
  const normalized = Number(value)
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    throw new Error('Code Graph SQLite rowid 超出安全范围')
  }
  return normalized
}

function requireMapValue(
  values: ReadonlyMap<string, number>,
  key: string,
  relation: string
): number {
  const value = values.get(key)
  if (value === undefined) throw new Error(`${relation} 无法解析：${key}`)
  return value
}

function readString(row: unknown, key: string): string {
  const value = readField(row, key)
  if (typeof value !== 'string') throw new Error(`Code Graph 行字段 ${key} 不是字符串`)
  return value
}

function readNumber(row: unknown, key: string): number {
  const value = readField(row, key)
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Code Graph 行字段 ${key} 不是数值`)
  }
  return value
}

function readNullableNumber(row: unknown, key: string): number | null {
  const value = readField(row, key)
  if (value === null) return null
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Code Graph 行字段 ${key} 不是可空数值`)
  }
  return value
}

function readNullableString(row: unknown, key: string): string | null {
  const value = readField(row, key)
  if (value === null) return null
  if (typeof value !== 'string') {
    throw new Error(`Code Graph 行字段 ${key} 不是可空字符串`)
  }
  return value
}

function readField(row: unknown, key: string): unknown {
  if (typeof row !== 'object' || row === null || !(key in row)) {
    throw new Error(`Code Graph 查询缺少字段 ${key}`)
  }
  return Reflect.get(row, key)
}

function isGraphLanguage(value: string): value is CodeGraphFileInput['language'] {
  return [
    'typescript',
    'tsx',
    'javascript',
    'jsx',
    'mjs',
    'cjs',
    'python',
    'unsupported'
  ].includes(value)
}

function isParseStatus(value: string): value is CodeGraphFileInput['parseStatus'] {
  return ['parsed', 'failed', 'unsupported', 'skipped_too_large'].includes(value)
}
