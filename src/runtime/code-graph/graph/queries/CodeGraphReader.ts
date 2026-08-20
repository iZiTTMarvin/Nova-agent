import * as path from 'node:path'
import Database from 'better-sqlite3'
import type {
  CodeEvidenceConfidence,
  CodeFileEdgeKind,
  CodeIndexCoverage,
  CodeRelationResolver,
  CodeSymbolEdgeKind,
  CodeSymbolKind,
  CodeUnresolvedReason,
  CodeUnresolvedRelationKind
} from '../../types'
import { readCodeGraphCoverage } from '../CodeGraphCoverage'

export const CODE_GRAPH_QUERY_CANDIDATE_LIMIT = 64
export const CODE_CONTEXT_QUERY_MAX_CHARS = 512
const CODE_GRAPH_QUERY_RELATION_LIMIT = 512
const CODE_GRAPH_QUERY_UNRESOLVED_LIMIT = 256

export interface CodeGraphNormalizedQuery {
  readonly original: string
  readonly folded: string
  readonly tokens: readonly string[]
}

export interface CodeGraphReadRequest {
  readonly query: CodeGraphNormalizedQuery
  readonly scope: string | null
  readonly relationDepth: 0 | 1 | 2
}

export interface CodeGraphReadSnapshot {
  readonly activeGeneration: number | null
  readonly revision: number
  readonly coverage: CodeIndexCoverage
}

export interface CodeGraphAnchorCandidate {
  readonly symbolId: number
  readonly fileId: number
  readonly stableId: string
  readonly name: string
  readonly qualifiedName: string
  readonly kind: CodeSymbolKind
  readonly path: string
  readonly startLine: number
  readonly endLine: number
  readonly fileLineCount: number
  readonly identifierTokens: string
  readonly exactName: boolean
  readonly exactQualifiedName: boolean
  readonly exactPath: boolean
  readonly ftsRank: number | null
}

export interface CodeGraphRelationCandidate {
  readonly stableId: string
  readonly graphKind: 'symbol' | 'file'
  readonly type: CodeSymbolEdgeKind | CodeFileEdgeKind
  readonly from: string
  readonly to: string
  readonly sourceSymbolStableId: string | null
  readonly targetSymbolStableId: string | null
  readonly sourceSymbolId: number | null
  readonly targetSymbolId: number | null
  readonly sourceFileId: number
  readonly targetFileId: number
  readonly confidence: CodeEvidenceConfidence
  readonly resolver: CodeRelationResolver
  readonly sourceFile: string
  readonly sourceLine: number
  readonly sourceFileLineCount: number
}

export interface CodeGraphUnresolvedCandidate {
  readonly stableId: string
  readonly fileId: number
  readonly sourceSymbolStableId: string | null
  readonly filePath: string
  readonly kind: CodeUnresolvedRelationKind
  readonly rawTarget: string
  readonly moduleSpecifier: string | null
  readonly sourceLine: number
  readonly reason: CodeUnresolvedReason
  readonly resolver: CodeRelationResolver
}

export interface CodeGraphQueryEvidence {
  readonly snapshot: CodeGraphReadSnapshot
  readonly anchors: readonly CodeGraphAnchorCandidate[]
  readonly relations: readonly CodeGraphRelationCandidate[]
  readonly unresolved: readonly CodeGraphUnresolvedCandidate[]
}

export interface CodeGraphReader {
  readEvidence(request: CodeGraphReadRequest): Promise<CodeGraphQueryEvidence>
  close(): Promise<void>
}

export interface BetterSqliteCodeGraphReaderOptions {
  readonly dbPath: string
}

/** 查询连接始终只读，并在同一 SQLite snapshot 中收集候选与关系。 */
export class BetterSqliteCodeGraphReader implements CodeGraphReader {
  private constructor(private readonly db: Database.Database) {}

  static open(options: BetterSqliteCodeGraphReaderOptions): BetterSqliteCodeGraphReader {
    const db = new Database(options.dbPath, { readonly: true, fileMustExist: true })
    try {
      db.pragma('query_only = ON')
      db.pragma('foreign_keys = ON')
      db.pragma('busy_timeout = 5000')
      return new BetterSqliteCodeGraphReader(db)
    } catch (error) {
      db.close()
      throw error
    }
  }

  async readEvidence(request: CodeGraphReadRequest): Promise<CodeGraphQueryEvidence> {
    assertNormalizedQuery(request.query)
    assertScope(request.scope)
    if (request.relationDepth !== 0 && request.relationDepth !== 1 && request.relationDepth !== 2) {
      throw new Error('Code Graph relationDepth 无效')
    }
    this.db.exec('BEGIN')
    try {
      const snapshot = this.readSnapshot()
      if (snapshot.activeGeneration === null) {
        this.db.exec('COMMIT')
        return Object.freeze({
          snapshot,
          anchors: Object.freeze([]),
          relations: Object.freeze([]),
          unresolved: Object.freeze([])
        })
      }
      const anchors = this.searchAnchors(
        snapshot.activeGeneration,
        request.query,
        request.scope
      )
      const relations = this.readRelations(
        snapshot.activeGeneration,
        anchors,
        request.relationDepth
      )
      const unresolved = this.readUnresolved(snapshot.activeGeneration, anchors)
      this.db.exec('COMMIT')
      return Object.freeze({
        snapshot,
        anchors: Object.freeze(anchors),
        relations: Object.freeze(relations),
        unresolved: Object.freeze(unresolved)
      })
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  async close(): Promise<void> {
    this.db.close()
  }

  private readSnapshot(): CodeGraphReadSnapshot {
    const metadata = this.db.prepare(
      `SELECT active_generation AS activeGeneration, revision
       FROM index_meta WHERE singleton = 1`
    ).get()
    const activeGeneration = readNullableNumber(metadata, 'activeGeneration')
    const revision = readNumber(metadata, 'revision')
    return Object.freeze({
      activeGeneration,
      revision,
      coverage: readCodeGraphCoverage(this.db, activeGeneration)
    })
  }

  private searchAnchors(
    generation: number,
    query: CodeGraphNormalizedQuery,
    scope: string | null
  ): CodeGraphAnchorCandidate[] {
    const candidates = new Map<string, CodeGraphAnchorCandidate>()
    const scopeFilter = buildScopeFilter(scope)
    const exactRows = this.db.prepare(
      `SELECT s.id AS symbolId, f.id AS fileId, s.stable_id AS stableId,
              s.name, s.qualified_name AS qualifiedName, s.kind,
              f.path, s.start_line AS startLine, s.end_line AS endLine,
              f.line_count AS fileLineCount, s.identifier_tokens AS identifierTokens
       FROM symbols s
       JOIN files f ON f.id = s.file_id
       WHERE s.generation = ?
         AND (
           lower(s.name) = ? OR lower(s.qualified_name) = ? OR
           (lower(f.path) = ? AND s.kind = 'module')
         )
         ${scopeFilter.sql}
       ORDER BY f.path, s.start_line, s.stable_id
       LIMIT ?`
    ).all(
      generation,
      query.folded,
      query.folded,
      query.folded,
      ...scopeFilter.params,
      CODE_GRAPH_QUERY_CANDIDATE_LIMIT
    )
    for (const row of exactRows) {
      const parsed = parseAnchor(row, query, null)
      candidates.set(parsed.stableId, parsed)
    }

    const ftsExpression = buildFtsExpression(query.tokens)
    if (ftsExpression) {
      const ftsRows = this.db.prepare(
        `SELECT s.id AS symbolId, f.id AS fileId, s.stable_id AS stableId,
                s.name, s.qualified_name AS qualifiedName, s.kind,
                f.path, s.start_line AS startLine, s.end_line AS endLine,
                f.line_count AS fileLineCount, s.identifier_tokens AS identifierTokens,
                bm25(symbol_fts) AS ftsRank
         FROM symbol_fts
         JOIN symbols s ON s.id = CAST(symbol_fts.symbol_id AS INTEGER)
         JOIN files f ON f.id = s.file_id
         WHERE symbol_fts MATCH ? AND s.generation = ?
           ${scopeFilter.sql}
         ORDER BY ftsRank, f.path, s.start_line, s.stable_id
         LIMIT ?`
      ).all(
        ftsExpression,
        generation,
        ...scopeFilter.params,
        CODE_GRAPH_QUERY_CANDIDATE_LIMIT
      )
      for (const row of ftsRows) {
        const parsed = parseAnchor(row, query, readNumber(row, 'ftsRank'))
        const existing = candidates.get(parsed.stableId)
        candidates.set(parsed.stableId, existing
          ? Object.freeze({ ...existing, ftsRank: parsed.ftsRank })
          : parsed)
      }
    }
    return [...candidates.values()]
      .sort((left, right) => left.stableId.localeCompare(right.stableId, 'en'))
      .slice(0, CODE_GRAPH_QUERY_CANDIDATE_LIMIT)
  }

  private readRelations(
    generation: number,
    anchors: readonly CodeGraphAnchorCandidate[],
    depth: 0 | 1 | 2
  ): CodeGraphRelationCandidate[] {
    if (anchors.length === 0 || depth === 0) return []
    const symbolIds = uniqueNumbers(anchors.map((anchor) => anchor.symbolId))
    const fileIds = uniqueNumbers(anchors.map((anchor) => anchor.fileId))
    const direct = this.queryRelations(generation, symbolIds, fileIds)
    if (depth === 1) return direct

    const neighborSymbolIds = uniqueNumbers(direct.flatMap((relation) => [
      relation.sourceSymbolId,
      relation.targetSymbolId
    ].filter((value): value is number => value !== null)))
    const neighborFileIds = uniqueNumbers(direct.flatMap((relation) => [
      relation.sourceFileId,
      relation.targetFileId
    ]))
    const expanded = this.queryRelations(generation, neighborSymbolIds, neighborFileIds)
    const merged = new Map<string, CodeGraphRelationCandidate>()
    for (const relation of [...direct, ...expanded]) merged.set(relation.stableId, relation)
    return [...merged.values()]
      .sort((left, right) => left.stableId.localeCompare(right.stableId, 'en'))
      .slice(0, CODE_GRAPH_QUERY_RELATION_LIMIT)
  }

  private queryRelations(
    generation: number,
    symbolIds: readonly number[],
    fileIds: readonly number[]
  ): CodeGraphRelationCandidate[] {
    if (symbolIds.length === 0 || fileIds.length === 0) return []
    const symbolPlaceholders = placeholders(symbolIds.length)
    const filePlaceholders = placeholders(fileIds.length)
    const relations: CodeGraphRelationCandidate[] = []

    const symbolRows = this.db.prepare(
      `SELECT edge.id, edge.kind, edge.confidence, edge.resolver,
              edge.source_file AS sourceFile, edge.source_line AS sourceLine,
              source.id AS sourceSymbolId,
              source.stable_id AS sourceStableId, source.name AS sourceName,
              target.id AS targetSymbolId,
              target.stable_id AS targetStableId, target.name AS targetName,
              source.file_id AS sourceFileId, target.file_id AS targetFileId,
              sourceFileRow.line_count AS sourceFileLineCount
       FROM symbol_edges edge
       JOIN symbols source ON source.id = edge.source_symbol_id
       JOIN symbols target ON target.id = edge.target_symbol_id
       JOIN files sourceFileRow ON sourceFileRow.id = source.file_id
       WHERE edge.generation = ?
         AND (edge.source_symbol_id IN (${symbolPlaceholders})
              OR edge.target_symbol_id IN (${symbolPlaceholders}))
       ORDER BY edge.id
       LIMIT ?`
    ).all(
      generation,
      ...symbolIds,
      ...symbolIds,
      CODE_GRAPH_QUERY_RELATION_LIMIT
    )
    for (const row of symbolRows) relations.push(parseSymbolRelation(row))

    const fileRows = this.db.prepare(
      `SELECT edge.id, edge.kind, edge.confidence, edge.resolver,
              edge.source_line AS sourceLine,
              source.id AS sourceFileId, source.path AS sourcePath,
              source.line_count AS sourceFileLineCount,
              target.id AS targetFileId, target.path AS targetPath
       FROM file_edges edge
       JOIN files source ON source.id = edge.source_file_id
       JOIN files target ON target.id = edge.target_file_id
       WHERE edge.generation = ?
         AND (edge.source_file_id IN (${filePlaceholders})
              OR edge.target_file_id IN (${filePlaceholders}))
       ORDER BY edge.id
       LIMIT ?`
    ).all(
      generation,
      ...fileIds,
      ...fileIds,
      CODE_GRAPH_QUERY_RELATION_LIMIT
    )
    for (const row of fileRows) relations.push(parseFileRelation(row))
    return relations
  }

  private readUnresolved(
    generation: number,
    anchors: readonly CodeGraphAnchorCandidate[]
  ): CodeGraphUnresolvedCandidate[] {
    if (anchors.length === 0) return []
    const fileIds = uniqueNumbers(anchors.map((anchor) => anchor.fileId))
    const symbolIds = uniqueNumbers(anchors.map((anchor) => anchor.symbolId))
    const rows = this.db.prepare(
      `SELECT relation.id, relation.kind, relation.raw_target AS rawTarget,
              relation.module_specifier AS moduleSpecifier,
              relation.source_line AS sourceLine, relation.reason, relation.resolver,
              file.id AS fileId, file.path AS filePath,
              symbol.stable_id AS sourceSymbolStableId
       FROM unresolved_relations relation
       JOIN files file ON file.id = relation.file_id
       LEFT JOIN symbols symbol ON symbol.id = relation.source_symbol_id
       WHERE relation.generation = ?
         AND (relation.file_id IN (${placeholders(fileIds.length)})
              OR relation.source_symbol_id IN (${placeholders(symbolIds.length)}))
       ORDER BY file.path, relation.source_line, relation.id
       LIMIT ?`
    ).all(
      generation,
      ...fileIds,
      ...symbolIds,
      CODE_GRAPH_QUERY_UNRESOLVED_LIMIT
    )
    return rows.map(parseUnresolved)
  }
}

export function openCodeGraphReader(
  options: BetterSqliteCodeGraphReaderOptions
): BetterSqliteCodeGraphReader {
  return BetterSqliteCodeGraphReader.open(options)
}

function parseAnchor(
  row: unknown,
  query: CodeGraphNormalizedQuery,
  ftsRank: number | null
): CodeGraphAnchorCandidate {
  const name = readString(row, 'name')
  const qualifiedName = readString(row, 'qualifiedName')
  const filePath = readString(row, 'path')
  return Object.freeze({
    symbolId: readNumber(row, 'symbolId'),
    fileId: readNumber(row, 'fileId'),
    stableId: readString(row, 'stableId'),
    name,
    qualifiedName,
    kind: readSymbolKind(row, 'kind'),
    path: filePath,
    startLine: readNumber(row, 'startLine'),
    endLine: readNumber(row, 'endLine'),
    fileLineCount: readNumber(row, 'fileLineCount'),
    identifierTokens: readString(row, 'identifierTokens'),
    exactName: name.toLowerCase() === query.folded,
    exactQualifiedName: qualifiedName.toLowerCase() === query.folded,
    exactPath: filePath.toLowerCase() === query.folded,
    ftsRank
  })
}

function parseSymbolRelation(row: unknown): CodeGraphRelationCandidate {
  return Object.freeze({
    stableId: `symbol-edge:${readNumber(row, 'id')}`,
    graphKind: 'symbol',
    type: readSymbolEdgeKind(row, 'kind'),
    from: readString(row, 'sourceName'),
    to: readString(row, 'targetName'),
    sourceSymbolStableId: readString(row, 'sourceStableId'),
    targetSymbolStableId: readString(row, 'targetStableId'),
    sourceSymbolId: readNumber(row, 'sourceSymbolId'),
    targetSymbolId: readNumber(row, 'targetSymbolId'),
    sourceFileId: readNumber(row, 'sourceFileId'),
    targetFileId: readNumber(row, 'targetFileId'),
    confidence: readConfidence(row, 'confidence'),
    resolver: readResolver(row, 'resolver'),
    sourceFile: readString(row, 'sourceFile'),
    sourceLine: readNumber(row, 'sourceLine'),
    sourceFileLineCount: readNumber(row, 'sourceFileLineCount')
  })
}

function parseFileRelation(row: unknown): CodeGraphRelationCandidate {
  const sourcePath = readString(row, 'sourcePath')
  return Object.freeze({
    stableId: `file-edge:${readNumber(row, 'id')}`,
    graphKind: 'file',
    type: readFileEdgeKind(row, 'kind'),
    from: sourcePath,
    to: readString(row, 'targetPath'),
    sourceSymbolStableId: null,
    targetSymbolStableId: null,
    sourceSymbolId: null,
    targetSymbolId: null,
    sourceFileId: readNumber(row, 'sourceFileId'),
    targetFileId: readNumber(row, 'targetFileId'),
    confidence: readConfidence(row, 'confidence'),
    resolver: readResolver(row, 'resolver'),
    sourceFile: sourcePath,
    sourceLine: readNumber(row, 'sourceLine'),
    sourceFileLineCount: readNumber(row, 'sourceFileLineCount')
  })
}

function parseUnresolved(row: unknown): CodeGraphUnresolvedCandidate {
  return Object.freeze({
    stableId: `unresolved:${readNumber(row, 'id')}`,
    fileId: readNumber(row, 'fileId'),
    sourceSymbolStableId: readNullableString(row, 'sourceSymbolStableId'),
    filePath: readString(row, 'filePath'),
    kind: readUnresolvedKind(row, 'kind'),
    rawTarget: readString(row, 'rawTarget'),
    moduleSpecifier: readNullableString(row, 'moduleSpecifier'),
    sourceLine: readNumber(row, 'sourceLine'),
    reason: readUnresolvedReason(row, 'reason'),
    resolver: readResolver(row, 'resolver')
  })
}

function buildScopeFilter(scope: string | null): {
  readonly sql: string
  readonly params: readonly string[]
} {
  if (scope === null) return { sql: '', params: [] }
  const escaped = scope.replace(/[\\%_]/g, '\\$&')
  return {
    sql: `AND (f.path = ? OR f.path LIKE ? ESCAPE '\\')`,
    params: [scope, `${escaped}/%`]
  }
}

function assertNormalizedQuery(query: CodeGraphNormalizedQuery): void {
  if (!query.original.trim() || !query.folded) throw new Error('代码查询不能为空')
  // Reader 也执行硬上限，防止未经 Builder 的调用放大 SQL/FTS 负载。
  if (query.original.length > CODE_CONTEXT_QUERY_MAX_CHARS) {
    throw new Error(`代码查询不得超过 ${CODE_CONTEXT_QUERY_MAX_CHARS} 个字符`)
  }
  if (query.folded !== query.original.replace(/\\/g, '/').toLowerCase()) {
    throw new Error('代码查询 folded 值未规范化')
  }
  if (query.tokens.some((token) => !/^[a-z0-9]+$/.test(token))) {
    throw new Error('代码查询 token 未规范化')
  }
}

function assertScope(scope: string | null): void {
  if (scope === null) return
  if (
    !scope || scope === '.' || scope.includes('\\') || scope.startsWith('/') ||
    scope.endsWith('/') ||
    scope === '..' || scope.startsWith('../') || scope.includes('/../') ||
    /^[A-Za-z]:/.test(scope) || path.posix.normalize(scope) !== scope
  ) {
    throw new Error('代码查询 scope 必须是规范化工作区相对路径')
  }
}

function buildFtsExpression(tokens: readonly string[]): string | null {
  return tokens.length === 0
    ? null
    : tokens.slice(0, 12).map((token) => `"${token}"*`).join(' OR ')
}

function placeholders(count: number): string {
  if (count < 1) throw new Error('SQL 参数集合不能为空')
  return new Array<string>(count).fill('?').join(', ')
}

function uniqueNumbers(values: readonly number[]): number[] {
  return [...new Set(values)].sort((left, right) => left - right)
}

function readRecord(row: unknown): Record<string, unknown> {
  if (!isRecord(row)) {
    throw new Error('Code Graph 查询返回了无效数据')
  }
  return row
}

function readString(row: unknown, key: string): string {
  const value = readRecord(row)[key]
  if (typeof value !== 'string') throw new Error(`Code Graph 字段 ${key} 不是字符串`)
  return value
}

function readNullableString(row: unknown, key: string): string | null {
  const value = readRecord(row)[key]
  if (value === null) return null
  if (typeof value !== 'string') throw new Error(`Code Graph 字段 ${key} 不是可空字符串`)
  return value
}

function readNumber(row: unknown, key: string): number {
  const value = readRecord(row)[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Code Graph 字段 ${key} 不是有限数字`)
  }
  return value
}

function readNullableNumber(row: unknown, key: string): number | null {
  const value = readRecord(row)[key]
  if (value === null) return null
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Code Graph 字段 ${key} 不是可空数字`)
  }
  return value
}

const SYMBOL_KINDS = [
  'module', 'class', 'interface', 'function', 'method', 'constructor', 'property',
  'variable', 'constant', 'type', 'enum', 'enum_member'
] as const
const SYMBOL_EDGE_KINDS = [
  'calls', 'references', 'extends', 'implements', 'overrides'
] as const
const FILE_EDGE_KINDS = ['imports', 're_exports', 'test_of'] as const
const UNRESOLVED_KINDS = [...SYMBOL_EDGE_KINDS, ...FILE_EDGE_KINDS] as const
const CONFIDENCES = ['confirmed', 'probable', 'heuristic'] as const
const RESOLVERS = [
  'structural', 'relative-path', 'tsconfig-paths', 'index-re-export',
  'python-import', 'test-convention'
] as const
const UNRESOLVED_REASONS = [
  'external_module', 'no_matching_file', 'ambiguous_module', 'export_not_found',
  'ambiguous_export', 'dynamic_dispatch', 'same_file_target_ambiguous',
  'reexport_depth_exceeded', 'shadowed_import_binding',
  'unsupported_project_reference', 'unsupported_conditional_export'
] as const

function readEnum<T extends string>(
  row: unknown,
  key: string,
  values: readonly T[]
): T {
  const value = readString(row, key)
  if (!isOneOf(value, values)) throw new Error(`Code Graph 字段 ${key} 枚举值无效`)
  return value
}

function readSymbolKind(row: unknown, key: string): CodeSymbolKind {
  return readEnum(row, key, SYMBOL_KINDS)
}

function readSymbolEdgeKind(row: unknown, key: string): CodeSymbolEdgeKind {
  return readEnum(row, key, SYMBOL_EDGE_KINDS)
}

function readFileEdgeKind(row: unknown, key: string): CodeFileEdgeKind {
  return readEnum(row, key, FILE_EDGE_KINDS)
}

function readUnresolvedKind(row: unknown, key: string): CodeUnresolvedRelationKind {
  return readEnum(row, key, UNRESOLVED_KINDS)
}

function readConfidence(row: unknown, key: string): CodeEvidenceConfidence {
  return readEnum(row, key, CONFIDENCES)
}

function readResolver(row: unknown, key: string): CodeRelationResolver {
  return readEnum(row, key, RESOLVERS)
}

function readUnresolvedReason(row: unknown, key: string): CodeUnresolvedReason {
  return readEnum(row, key, UNRESOLVED_REASONS)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isOneOf<T extends string>(value: string, values: readonly T[]): value is T {
  return values.some((candidate) => candidate === value)
}
