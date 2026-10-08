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
  MemoryDocumentStats,
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

// ---------------------------------------------------------------------------
// 结构化长期记忆与来源记录。
// 时间戳统一为 number（ms epoch），边界逐字段校验。
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

/**
 * 一次彻底遗忘的闭包：目标条目连同被它取代/合并的旧版本。
 * contents 承载正文用于逐字节核查派生副本，不跨模块再扩散。
 */
export interface ForgottenMemory {
  scope: MemoryScope
  ids: readonly string[]
  contents: readonly string[]
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
  aliases?: readonly string[]
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
  aliases?: readonly string[]
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
  | { operation: 'RETRACT'; reason: MemoryPolicyReason; targetId: string; disposal: 'archive' | 'purge' }
  | { operation: 'IGNORE'; reason: MemoryPolicyReason }
