/** 磁盘扫描到的单条 Markdown 记忆文件 */
export interface ScannedMemoryFile {
  relPath: string
  body: string
  size: number
  mtimeMs: number
  fingerprint: string
}

/** reconcile 计划：对比磁盘与索引后的增删改 */
export interface ReconcilePlan {
  added: ScannedMemoryFile[]
  updated: ScannedMemoryFile[]
  removed: string[]
}

export type {
  MemoryScopeFileEntry,
  MemoryScopeStats,
  ReconcileStats
} from '../../shared/memory/types'

/** FTS 检索命中（score 为 -bm25，越大越相关） */
export interface MemorySearchHit {
  scopeId: string
  relPath: string
  body: string
  score: number
}

/** search 可选参数 */
export interface MemorySearchOptions {
  limit?: number
  scoreFloor?: number
}

/** FtsQueryBuilder 分派路径 */
export type FtsQueryPath = 'trigram' | 'unicode61' | 'none'

export interface BuiltMatchQuery {
  query: string | null
  path: FtsQueryPath
}

// ---------------------------------------------------------------------------
// 结构化长期记忆（memory_records / memory_evidence）
// 时间戳统一为 number（ms epoch）；联合值即 DB 存储字符串，边界逐字段校验。
// ---------------------------------------------------------------------------

export type ScopeKind = 'project' | 'global'
export type MemoryKind =
  | 'preference'
  | 'convention'
  | 'project_fact'
  | 'decision'
  | 'workflow'
  | 'gotcha'
export type MemoryStatus =
  | 'pending'
  | 'active'
  | 'superseded'
  | 'retracted'
  | 'needs_verification'
export type Explicitness = 'user_explicit' | 'workspace_verified' | 'observed' | 'inferred'
export type MemoryEvidenceType = 'user_message' | 'tool_result' | 'workspace'

export const SCOPE_KINDS: readonly ScopeKind[] = ['project', 'global']
export const MEMORY_KINDS: readonly MemoryKind[] = [
  'preference',
  'convention',
  'project_fact',
  'decision',
  'workflow',
  'gotcha'
]
export const MEMORY_STATUSES: readonly MemoryStatus[] = [
  'pending',
  'active',
  'superseded',
  'retracted',
  'needs_verification'
]
export const EXPLICITNESS_LEVELS: readonly Explicitness[] = [
  'user_explicit',
  'workspace_verified',
  'observed',
  'inferred'
]
export const MEMORY_EVIDENCE_TYPES: readonly MemoryEvidenceType[] = [
  'user_message',
  'tool_result',
  'workspace'
]

/** 记忆归属 scope：project 用 workspace hash，global 固定 'user' */
export interface MemoryScope {
  scopeKind: ScopeKind
  scopeId: string
}

/**
 * 单条结构化长期记忆。metadata 是开放扩展字段：稳定语义必须落在显式列上，
 * 只允许存放附加信息；边界保证其为 JSON 对象或 null。
 */
export interface MemoryRecord {
  id: string
  scopeKind: ScopeKind
  scopeId: string
  kind: MemoryKind
  memoryKey: string | null
  content: string
  status: MemoryStatus
  confidence: number
  explicitness: Explicitness
  sourceType: string
  validFrom: number
  validTo: number | null
  supersedesId: string | null
  evidenceCount: number
  distinctSessionCount: number
  distinctProjectCount: number
  sourcePath: string | null
  sourceFingerprint: string | null
  createdAt: number
  updatedAt: number
  lastSeenAt: number
  metadata: Readonly<Record<string, unknown>> | null
}

export interface MemoryEvidence {
  id: string
  memoryId: string
  sessionId: string | null
  messageId: string | null
  projectScopeId: string | null
  evidenceType: MemoryEvidenceType
  excerpt: string | null
  createdAt: number
}

/** stats 聚合行（按 scope/kind/status 分组计数） */
export interface MemoryRecordStatsRow {
  scopeKind: ScopeKind
  scopeId: string
  kind: MemoryKind
  status: MemoryStatus
  count: number
}

// ---------------------------------------------------------------------------
// 候选记忆与确定性决策（extraction → policy → processor 管线）
// LLM 只输出候选语义；ADD/MERGE/SUPERSEDE/RETRACT/IGNORE 全部由纯函数 policy 决定。
// ---------------------------------------------------------------------------

export type ScopeHint = 'project' | 'global'
/** LLM 只表达「用户在否定/撤回某偏好」这一语义；最终操作仍由 policy 定 */
export type MemoryCandidateIntent = 'assert' | 'negate'

export const SCOPE_HINTS: readonly ScopeHint[] = ['project', 'global']
export const MEMORY_CANDIDATE_INTENTS: readonly MemoryCandidateIntent[] = ['assert', 'negate']

export interface MemoryCandidateEvidence {
  type: MemoryEvidenceType
  sessionId?: string
  messageId?: string
  excerpt: string
  sourcePath?: string
}

export interface MemoryCandidate {
  kind: MemoryKind
  scopeHint: ScopeHint
  /** 可空：gotcha 等自然语言经验无稳定身份 */
  memoryKey: string | null
  content: string
  explicitness: Explicitness
  /** [0,1]，边界校验时 clamp */
  confidence: number
  intent: MemoryCandidateIntent
  /** 边界保证非空：无有效证据的候选在提炼层即被丢弃 */
  evidence: readonly MemoryCandidateEvidence[]
}

/** processor 查询注入的等价族既有记录；证据去重集合用于确定性计数与晋升判定 */
export interface MemoryPolicyRelatedRecord {
  record: MemoryRecord
  evidenceSessionIds: ReadonlySet<string>
  evidenceProjectScopeIds: ReadonlySet<string>
}

export interface MemoryPolicyContext {
  /** 决策确定性要求：时间由调用方注入，policy 内部禁止读时钟/随机源 */
  now: number
  sessionId: string
  projectScopeId: string
  relatedRecords: readonly MemoryPolicyRelatedRecord[]
}

export type MemoryPolicyOperation = 'ADD' | 'MERGE' | 'SUPERSEDE' | 'RETRACT' | 'IGNORE'

export type MemoryPolicyReason =
  | 'strong-evidence-active'
  | 'observed-pending'
  | 'inferred-pending'
  | 'conflict-pending'
  | 'equivalent-merge'
  | 'equivalent-merge-promoted'
  | 'mutable-fact-superseded'
  | 'negate-retract'
  | 'negate-replace'
  | 'no-evidence'
  | 'inferred-below-threshold'
  | 'equivalent-retracted'
  | 'negate-no-target'

/** policy 产出的新记录形状；id 与时间戳由 processor 生成 */
export interface MemoryPolicyRecordDraft {
  scope: MemoryScope
  kind: MemoryKind
  memoryKey: string | null
  content: string
  status: 'active' | 'pending'
  confidence: number
  explicitness: Explicitness
  sourceType: MemoryEvidenceType
  sourcePath: string | null
  evidence: readonly MemoryCandidateEvidence[]
}

/** discriminated union：每种操作携带 processor 无歧义执行所需的全部字段 */
export type MemoryPolicyDecision =
  | { operation: 'ADD'; reason: MemoryPolicyReason; draft: MemoryPolicyRecordDraft }
  | {
      operation: 'MERGE'
      reason: MemoryPolicyReason
      targetId: string
      evidence: readonly MemoryCandidateEvidence[]
      /** 合并后的目标置信度（温和上调，只升不降） */
      confidence: number
      distinctSessionCount: number
      distinctProjectCount: number
      /** 跨过晋升门槛时 pending → active */
      promote: boolean
    }
  | {
      operation: 'SUPERSEDE'
      reason: MemoryPolicyReason
      targetId: string
      draft: MemoryPolicyRecordDraft
    }
  | { operation: 'RETRACT'; reason: MemoryPolicyReason; targetId: string }
  | { operation: 'IGNORE'; reason: MemoryPolicyReason }

// 行 → 领域对象的唯一权威转换：DB 行先按 unknown 接收，逐字段校验后产出。

function asRow(row: unknown, source: string): Record<string, unknown> {
  if (typeof row !== 'object' || row === null || Array.isArray(row)) {
    throw new Error(`${source} 行格式非法：期望对象`)
  }
  return row as Record<string, unknown>
}

function readString(row: Record<string, unknown>, field: string, source: string): string {
  const v = row[field]
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`${source} 字段 ${field} 缺失或非非空字符串`)
  }
  return v
}

function readNullableString(
  row: Record<string, unknown>,
  field: string,
  source: string
): string | null {
  const v = row[field]
  if (v === null || v === undefined) {
    return null
  }
  if (typeof v !== 'string') {
    throw new Error(`${source} 字段 ${field} 非字符串`)
  }
  return v
}

function readNumber(row: Record<string, unknown>, field: string, source: string): number {
  const v = row[field]
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new Error(`${source} 字段 ${field} 缺失或非有限数值`)
  }
  return v
}

function readNullableNumber(
  row: Record<string, unknown>,
  field: string,
  source: string
): number | null {
  const v = row[field]
  if (v === null || v === undefined) {
    return null
  }
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new Error(`${source} 字段 ${field} 非数值`)
  }
  return v
}

function readEnum<T extends string>(
  row: Record<string, unknown>,
  field: string,
  allowed: readonly T[],
  source: string
): T {
  const v = readString(row, field, source)
  if (!(allowed as readonly string[]).includes(v)) {
    throw new Error(`${source} 字段 ${field} 值 "${v}" 不在允许集合内`)
  }
  return v as T
}

function readMetadata(row: Record<string, unknown>): Readonly<Record<string, unknown>> | null {
  const raw = readNullableString(row, 'metadataJson', 'memory_records')
  if (raw === null) {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('memory_records.metadata_json 不是合法 JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('memory_records.metadata_json 必须是 JSON 对象')
  }
  return parsed as Record<string, unknown>
}

/** memory_records 查询行（camelCase 别名）→ MemoryRecord */
export function parseMemoryRecordRow(row: unknown): MemoryRecord {
  const r = asRow(row, 'memory_records')
  return {
    id: readString(r, 'id', 'memory_records'),
    scopeKind: readEnum(r, 'scopeKind', SCOPE_KINDS, 'memory_records'),
    scopeId: readString(r, 'scopeId', 'memory_records'),
    kind: readEnum(r, 'kind', MEMORY_KINDS, 'memory_records'),
    memoryKey: readNullableString(r, 'memoryKey', 'memory_records'),
    content: readString(r, 'content', 'memory_records'),
    status: readEnum(r, 'status', MEMORY_STATUSES, 'memory_records'),
    confidence: readNumber(r, 'confidence', 'memory_records'),
    explicitness: readEnum(r, 'explicitness', EXPLICITNESS_LEVELS, 'memory_records'),
    sourceType: readString(r, 'sourceType', 'memory_records'),
    validFrom: readNumber(r, 'validFrom', 'memory_records'),
    validTo: readNullableNumber(r, 'validTo', 'memory_records'),
    supersedesId: readNullableString(r, 'supersedesId', 'memory_records'),
    evidenceCount: readNumber(r, 'evidenceCount', 'memory_records'),
    distinctSessionCount: readNumber(r, 'distinctSessionCount', 'memory_records'),
    distinctProjectCount: readNumber(r, 'distinctProjectCount', 'memory_records'),
    sourcePath: readNullableString(r, 'sourcePath', 'memory_records'),
    sourceFingerprint: readNullableString(r, 'sourceFingerprint', 'memory_records'),
    createdAt: readNumber(r, 'createdAt', 'memory_records'),
    updatedAt: readNumber(r, 'updatedAt', 'memory_records'),
    lastSeenAt: readNumber(r, 'lastSeenAt', 'memory_records'),
    metadata: readMetadata(r)
  }
}

/** memory_evidence 查询行（camelCase 别名）→ MemoryEvidence */
export function parseMemoryEvidenceRow(row: unknown): MemoryEvidence {
  const r = asRow(row, 'memory_evidence')
  return {
    id: readString(r, 'id', 'memory_evidence'),
    memoryId: readString(r, 'memoryId', 'memory_evidence'),
    sessionId: readNullableString(r, 'sessionId', 'memory_evidence'),
    messageId: readNullableString(r, 'messageId', 'memory_evidence'),
    projectScopeId: readNullableString(r, 'projectScopeId', 'memory_evidence'),
    evidenceType: readEnum(r, 'evidenceType', MEMORY_EVIDENCE_TYPES, 'memory_evidence'),
    excerpt: readNullableString(r, 'excerpt', 'memory_evidence'),
    createdAt: readNumber(r, 'createdAt', 'memory_evidence')
  }
}

/** stats 聚合行 → MemoryRecordStatsRow */
export function parseMemoryStatsRow(row: unknown): MemoryRecordStatsRow {
  const r = asRow(row, 'memory_records stats')
  return {
    scopeKind: readEnum(r, 'scopeKind', SCOPE_KINDS, 'memory_records stats'),
    scopeId: readString(r, 'scopeId', 'memory_records stats'),
    kind: readEnum(r, 'kind', MEMORY_KINDS, 'memory_records stats'),
    status: readEnum(r, 'status', MEMORY_STATUSES, 'memory_records stats'),
    count: readNumber(r, 'count', 'memory_records stats')
  }
}
