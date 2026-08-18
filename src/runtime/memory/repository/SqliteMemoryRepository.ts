/**
 * MemoryRepository 的 SQLite 实现：prepared statements + 事务，经 MemoryDb 端口访问。
 * FTS 行同步完全由 schema 触发器承担，本层只写 memory_records / memory_evidence。
 * 写操作的事务边界是数据一致性根因位置：记录与证据要么同时落库要么整体回滚。
 */
import { randomUUID } from 'node:crypto'
import type { MemoryDb, MemoryDbStatement } from '../MemoryDb'
import { buildMatchQuery, negateBm25, DEFAULT_SEARCH_LIMIT } from '../FtsQueryBuilder'
import {
  parseMemoryEvidenceRow,
  parseMemoryRecordRow,
  parseMemoryStatsRow
} from '../types'
import type {
  MemoryEvidence,
  MemoryKind,
  MemoryRecord,
  MemoryRecordStatsRow,
  MemoryScope,
  MemoryStatus
} from '../types'
import type {
  MemoryEvidenceDraft,
  MemoryEvidenceMergeInput,
  MemoryFtsSearchOptions,
  MemoryRecordDraft,
  MemoryRecordFtsHit,
  MemoryRecordListOptions,
  MemoryRepository,
  MemoryStatusUpdateOptions,
  MemorySupersedeResult
} from './MemoryRepository'
import { DEFAULT_RECORD_LIST_LIMIT } from './MemoryRepository'

export interface SqliteMemoryRepositoryOptions {
  /** 时间源（ms）；测试注入固定时钟 */
  now?: () => number
  /** 证据 id 生成器 */
  generateId?: () => string
}

/** 查询行统一用 camelCase 别名；统一以 mr 别名引用 memory_records，供单表与 FTS join 共用 */
const RECORD_COLUMNS = `
  mr.id,
  mr.scope_kind AS scopeKind,
  mr.scope_id AS scopeId,
  mr.kind,
  mr.memory_key AS memoryKey,
  mr.content,
  mr.status,
  mr.confidence,
  mr.explicitness,
  mr.source_type AS sourceType,
  mr.valid_from AS validFrom,
  mr.valid_to AS validTo,
  mr.supersedes_id AS supersedesId,
  mr.evidence_count AS evidenceCount,
  mr.distinct_session_count AS distinctSessionCount,
  mr.distinct_project_count AS distinctProjectCount,
  mr.source_path AS sourcePath,
  mr.source_fingerprint AS sourceFingerprint,
  mr.created_at AS createdAt,
  mr.updated_at AS updatedAt,
  mr.last_seen_at AS lastSeenAt,
  mr.metadata_json AS metadataJson`

const INSERT_RECORD_SQL = `
  INSERT INTO memory_records (
    id, scope_kind, scope_id, kind, memory_key, content, status, confidence, explicitness,
    source_type, valid_from, valid_to, supersedes_id, evidence_count, distinct_session_count,
    distinct_project_count, source_path, source_fingerprint, created_at, updated_at, last_seen_at,
    metadata_json
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`

const INSERT_EVIDENCE_SQL = `
  INSERT INTO memory_evidence (
    id, memory_id, session_id, message_id, project_scope_id, evidence_type, excerpt, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`

export class SqliteMemoryRepository implements MemoryRepository {
  private readonly statements = new Map<string, MemoryDbStatement>()
  private readonly nowFn: () => number
  private readonly generateIdFn: () => string

  constructor(
    private readonly db: MemoryDb,
    options: SqliteMemoryRepositoryOptions = {}
  ) {
    this.nowFn = options.now ?? Date.now
    this.generateIdFn = options.generateId ?? randomUUID
  }

  insertRecord(draft: MemoryRecordDraft): MemoryRecord {
    assertNonEmpty(draft.id, 'id')
    assertNonEmpty(draft.scope.scopeId, 'scopeId')
    assertNonEmpty(draft.content, 'content')

    const now = this.nowFn()
    const createdAt = now
    const metadataJson = serializeMetadata(draft.metadata)
    const evidence = draft.evidence ?? []

    this.inTransaction(() => {
      this.stmt(INSERT_RECORD_SQL).run(
        draft.id,
        draft.scope.scopeKind,
        draft.scope.scopeId,
        draft.kind,
        draft.memoryKey,
        draft.content,
        draft.status,
        draft.confidence,
        draft.explicitness,
        draft.sourceType,
        draft.validFrom ?? now,
        draft.validTo ?? null,
        draft.supersedesId ?? null,
        evidence.length,
        draft.distinctSessionCount ?? 1,
        draft.distinctProjectCount ?? 1,
        draft.sourcePath ?? null,
        draft.sourceFingerprint ?? null,
        createdAt,
        createdAt,
        draft.lastSeenAt ?? createdAt,
        metadataJson
      )
      for (const item of evidence) {
        this.insertEvidenceRow(item, draft.id, createdAt)
      }
    })

    const saved = this.findById(draft.id)
    if (!saved) {
      throw new Error(`memory_records 写入后读取失败：${draft.id}`)
    }
    return saved
  }

  findById(id: string): MemoryRecord | null {
    const row = this.stmt(`SELECT ${RECORD_COLUMNS} FROM memory_records mr WHERE mr.id = ?`).get(id)
    return row === undefined ? null : parseMemoryRecordRow(row)
  }

  findActiveByKey(scope: MemoryScope, kind: MemoryKind, memoryKey: string): MemoryRecord | null {
    const row = this.stmt(
      `SELECT ${RECORD_COLUMNS} FROM memory_records mr
       WHERE mr.scope_kind = ? AND mr.scope_id = ? AND mr.kind = ? AND mr.memory_key = ?
         AND mr.status = 'active'
       LIMIT 1`
    ).get(scope.scopeKind, scope.scopeId, kind, memoryKey)
    return row === undefined ? null : parseMemoryRecordRow(row)
  }

  countActiveByKey(scope: MemoryScope, kind: MemoryKind, memoryKey: string): number {
    const row = this.stmt(
      `SELECT COUNT(*) AS cnt FROM memory_records mr
       WHERE mr.scope_kind = ? AND mr.scope_id = ? AND mr.kind = ? AND mr.memory_key = ?
         AND mr.status = 'active'`
    ).get<{ cnt: number }>(scope.scopeKind, scope.scopeId, kind, memoryKey)
    return row?.cnt ?? 0
  }

  listByScope(scope: MemoryScope, options: MemoryRecordListOptions = {}): MemoryRecord[] {
    const conditions = ['mr.scope_kind = ?', 'mr.scope_id = ?']
    const params: unknown[] = [scope.scopeKind, scope.scopeId]
    if (options.status !== undefined) {
      conditions.push('mr.status = ?')
      params.push(options.status)
    }
    if (options.kind !== undefined) {
      conditions.push('mr.kind = ?')
      params.push(options.kind)
    }
    const limit = options.limit ?? DEFAULT_RECORD_LIST_LIMIT
    params.push(limit)

    const rows = this.stmt(
      `SELECT ${RECORD_COLUMNS} FROM memory_records mr
       WHERE ${conditions.join(' AND ')}
       ORDER BY mr.updated_at DESC, mr.id ASC
       LIMIT ?`
    ).all(...params)
    return rows.map(parseMemoryRecordRow)
  }

  listEvidence(memoryId: string): MemoryEvidence[] {
    const rows = this.stmt(
      `SELECT
         id,
         memory_id AS memoryId,
         session_id AS sessionId,
         message_id AS messageId,
         project_scope_id AS projectScopeId,
         evidence_type AS evidenceType,
         excerpt,
         created_at AS createdAt
       FROM memory_evidence
       WHERE memory_id = ?
       ORDER BY created_at ASC, id ASC`
    ).all(memoryId)
    return rows.map(parseMemoryEvidenceRow)
  }

  updateStatus(id: string, status: MemoryStatus, options: MemoryStatusUpdateOptions = {}): boolean {
    const changes = this.stmt(
      `UPDATE memory_records
       SET status = ?, valid_to = COALESCE(?, valid_to), supersedes_id = COALESCE(?, supersedes_id),
           updated_at = ?
       WHERE id = ?`
    ).run(status, options.validTo ?? null, options.supersedesId ?? null, this.nowFn(), id).changes
    return changes > 0
  }

  markSuperseded(oldId: string, newId: string): MemorySupersedeResult {
    const now = this.nowFn()
    return this.inTransaction(() => {
      const oldMarked = this.stmt(
        `UPDATE memory_records SET status = 'superseded', valid_to = ?, updated_at = ? WHERE id = ?`
      ).run(now, now, oldId).changes
      const newLinked = this.stmt(
        `UPDATE memory_records SET supersedes_id = ?, updated_at = ? WHERE id = ?`
      ).run(oldId, now, newId).changes
      return { oldMarked, newLinked }
    })
  }

  mergeEvidence(id: string, input: MemoryEvidenceMergeInput): boolean {
    const now = this.nowFn()
    return this.inTransaction(() => {
      for (const item of input.evidence) {
        this.insertEvidenceRow(item, id, now)
      }
      const changes = this.stmt(
        `UPDATE memory_records
         SET evidence_count = evidence_count + ?,
             last_seen_at = ?,
             confidence = COALESCE(?, confidence),
             distinct_session_count = COALESCE(?, distinct_session_count),
             distinct_project_count = COALESCE(?, distinct_project_count),
             updated_at = ?
         WHERE id = ?`
      ).run(
        input.evidence.length,
        input.lastSeenAt ?? now,
        input.confidence ?? null,
        input.distinctSessionCount ?? null,
        input.distinctProjectCount ?? null,
        now,
        id
      ).changes
      return changes > 0
    })
  }

  searchFts(query: string, options: MemoryFtsSearchOptions = {}): MemoryRecordFtsHit[] {
    const built = buildMatchQuery(query)
    if (!built.query) {
      return []
    }

    const status = options.status ?? 'active'
    const limit = options.limit ?? DEFAULT_SEARCH_LIMIT
    const conditions = ['memory_record_fts MATCH ?']
    const params: unknown[] = [built.query]

    if (status !== 'any') {
      conditions.push('memory_record_fts.status = ?')
      params.push(status)
    }
    if (options.scope) {
      conditions.push('mr.scope_kind = ?', 'mr.scope_id = ?')
      params.push(options.scope.scopeKind, options.scope.scopeId)
    } else if (options.scopeKinds !== undefined && options.scopeKinds.length > 0) {
      // 占位符数量随选项结构变化，值仍全部走参数绑定
      conditions.push(
        `memory_record_fts.scope_kind IN (${options.scopeKinds.map(() => '?').join(', ')})`
      )
      params.push(...options.scopeKinds)
    }

    params.push(limit)
    const rows = this.stmt(
      `SELECT ${RECORD_COLUMNS}, bm25(memory_record_fts) AS bm25
       FROM memory_record_fts
       JOIN memory_records mr ON mr.rowid = memory_record_fts.rowid
       WHERE ${conditions.join(' AND ')}
       ORDER BY bm25 ASC, mr.id ASC
       LIMIT ?`
    ).all(...params)

    return rows.map((row) => {
      const hit = row as { bm25: number }
      return { record: parseMemoryRecordRow(row), score: negateBm25(hit.bm25) }
    })
  }

  retract(id: string): boolean {
    const changes = this.stmt(
      `UPDATE memory_records SET status = 'retracted', updated_at = ? WHERE id = ?`
    ).run(this.nowFn(), id).changes
    return changes > 0
  }

  stats(scope?: MemoryScope): MemoryRecordStatsRow[] {
    const conditions: string[] = []
    const params: unknown[] = []
    if (scope) {
      conditions.push('scope_kind = ?', 'scope_id = ?')
      params.push(scope.scopeKind, scope.scopeId)
    }
    const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : ''
    const rows = this.stmt(
      `SELECT scope_kind AS scopeKind, scope_id AS scopeId, kind, status, COUNT(*) AS count
       FROM memory_records${where}
       GROUP BY scope_kind, scope_id, kind, status
       ORDER BY scope_kind, scope_id, kind, status`
    ).all(...params)
    return rows.map(parseMemoryStatsRow)
  }

  private insertEvidenceRow(item: MemoryEvidenceDraft, memoryId: string, fallbackCreatedAt: number): void {
    this.stmt(INSERT_EVIDENCE_SQL).run(
      item.id ?? this.generateIdFn(),
      memoryId,
      item.sessionId ?? null,
      item.messageId ?? null,
      item.projectScopeId ?? null,
      item.evidenceType,
      item.excerpt ?? null,
      item.createdAt ?? fallbackCreatedAt
    )
  }

  private inTransaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (err) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // 事务已被底层错误中断时忽略二次失败，保留原始错误
      }
      throw err
    }
  }

  private stmt(sql: string): MemoryDbStatement {
    let statement = this.statements.get(sql)
    if (!statement) {
      statement = this.db.prepare(sql)
      this.statements.set(sql, statement)
    }
    return statement
  }
}

function assertNonEmpty(value: string, field: string): void {
  if (value.length === 0) {
    throw new Error(`memory_records 字段 ${field} 不能为空`)
  }
}

function serializeMetadata(metadata: Readonly<Record<string, unknown>> | null | undefined): string | null {
  if (metadata === null || metadata === undefined) {
    return null
  }
  if (typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new Error('memory metadata 必须是 JSON 对象')
  }
  return JSON.stringify(metadata)
}
