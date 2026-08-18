/**
 * 结构化长期记忆仓储端口：memory_records / memory_evidence 的原子数据操作契约。
 * 仓储只提供确定性读写与事务边界，不做业务决策（是否 supersede / retract / 晋升属 policy）。
 */
import type {
  Explicitness,
  MemoryEvidence,
  MemoryEvidenceType,
  MemoryKind,
  MemoryRecord,
  MemoryRecordStatsRow,
  MemoryScope,
  MemoryStatus,
  ScopeKind
} from '../types'

/** 新记录完整落库字段；id 由调用方（policy）生成，用于预先建立 supersedes 链 */
export interface MemoryRecordDraft {
  id: string
  scope: MemoryScope
  kind: MemoryKind
  /** 可空：gotcha 等自然语言经验允许无 key */
  memoryKey: string | null
  content: string
  status: MemoryStatus
  confidence: number
  explicitness: Explicitness
  sourceType: string
  validFrom?: number
  validTo?: number | null
  supersedesId?: string | null
  distinctSessionCount?: number
  distinctProjectCount?: number
  sourcePath?: string | null
  sourceFingerprint?: string | null
  lastSeenAt?: number
  /** 开放扩展信息；必须是 JSON 对象 */
  metadata?: Readonly<Record<string, unknown>> | null
  evidence?: readonly MemoryEvidenceDraft[]
}

export interface MemoryEvidenceDraft {
  /** 未提供时由仓储生成 */
  id?: string
  sessionId?: string | null
  messageId?: string | null
  projectScopeId?: string | null
  evidenceType: MemoryEvidenceType
  excerpt?: string | null
  createdAt?: number
}

export interface MemoryRecordListOptions {
  status?: MemoryStatus
  kind?: MemoryKind
  limit?: number
}

export interface MemoryStatusUpdateOptions {
  validTo?: number
  supersedesId?: string
}

export interface MemoryEvidenceMergeInput {
  evidence: readonly MemoryEvidenceDraft[]
  lastSeenAt?: number
  confidence?: number
  distinctSessionCount?: number
  distinctProjectCount?: number
}

/** 'any' 表示不过滤状态（历史检索用）；默认 'active' */
export type MemoryFtsStatusFilter = MemoryStatus | 'any'

export interface MemoryFtsSearchOptions {
  status?: MemoryFtsStatusFilter
  scopeKinds?: readonly ScopeKind[]
  /** 精确 scope 过滤；提供时优先于 scopeKinds */
  scope?: MemoryScope
  limit?: number
}

export interface MemoryRecordFtsHit {
  record: MemoryRecord
  /** -bm25，越大越相关 */
  score: number
}

export interface MemorySupersedeResult {
  oldMarked: number
  newLinked: number
}

export const DEFAULT_RECORD_LIST_LIMIT = 200

export interface MemoryRepository {
  /** 插入记录并批量写入 evidence（单事务：任一失败整体回滚） */
  insertRecord(draft: MemoryRecordDraft): MemoryRecord
  findById(id: string): MemoryRecord | null
  /** 同 (scope, kind, key) 下当前 active 的记录 */
  findActiveByKey(scope: MemoryScope, kind: MemoryKind, memoryKey: string): MemoryRecord | null
  countActiveByKey(scope: MemoryScope, kind: MemoryKind, memoryKey: string): number
  /** 按 updated_at 倒序 */
  listByScope(scope: MemoryScope, options?: MemoryRecordListOptions): MemoryRecord[]
  listEvidence(memoryId: string): MemoryEvidence[]
  /** 通用状态写入；返回目标行是否存在 */
  updateStatus(id: string, status: MemoryStatus, options?: MemoryStatusUpdateOptions): boolean
  /** old 标记 superseded（valid_to=now）并让 new.supersedes_id 指向 old（单事务） */
  markSuperseded(oldId: string, newId: string): MemorySupersedeResult
  /** 追加证据并同步计数（evidence_count 累加）、lastSeenAt 与可选置信度/去重计数（单事务） */
  mergeEvidence(id: string, input: MemoryEvidenceMergeInput): boolean
  /** FTS 检索；query 经 sanitize，默认只回 active */
  searchFts(query: string, options?: MemoryFtsSearchOptions): MemoryRecordFtsHit[]
  retract(id: string): boolean
  /** 按 scope/kind/status 聚合计数 */
  stats(scope?: MemoryScope): MemoryRecordStatsRow[]
}
