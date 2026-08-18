/**
 * 记忆模块 IPC 共享类型（renderer ↔ main）。
 * 与 runtime/memory 的领域类型分离：这里只放穿越进程边界的 DTO。
 */

/** scope 目录下单个 .md 文件元信息（不含正文） */
export interface MemoryScopeFileEntry {
  relPath: string
  size: number
  mtimeMs: number
}

/** scope 文档记忆统计（磁盘 + 索引） */
export interface MemoryDocumentStats {
  scopeId: string
  scopeDir: string
  fileCount: number
  indexCount: number
  diskBytes: number
}

/** memory:stats 的 IPC 返回：文档统计 + 结构化记录计数 */
export interface MemoryScopeStats extends MemoryDocumentStats {
  /** 当前项目 scope 下结构化记忆按状态计数 */
  records: MemoryRecordStatusCounts
}

/** 结构化记忆按状态计数 */
export interface MemoryRecordStatusCounts {
  active: number
  pending: number
  superseded: number
  retracted: number
  needsVerification: number
}

/** reconcile 执行统计 */
export interface ReconcileStats {
  added: number
  updated: number
  removed: number
  skipped: number
}

export interface MemoryReadFileParams {
  relPath: string
}

export interface MemoryWriteFileParams {
  relPath: string
  content: string
}

// ── 结构化长期记忆（settings 学习记忆查看器） ──────────────────────

export type MemoryScopeKindDto = 'project' | 'global'

export type MemoryKindDto =
  | 'preference'
  | 'convention'
  | 'project_fact'
  | 'decision'
  | 'workflow'
  | 'gotcha'

export type MemoryStatusDto =
  | 'pending'
  | 'active'
  | 'superseded'
  | 'retracted'
  | 'needs_verification'

export type MemoryExplicitnessDto = 'user_explicit' | 'workspace_verified' | 'observed' | 'inferred'

/**
 * 单条结构化记忆的展示 DTO：不含 evidence 全文与内部指纹，
 * 只保留用户管理所需的最小字段。
 */
export interface MemoryRecordDto {
  id: string
  scopeKind: MemoryScopeKindDto
  kind: MemoryKindDto
  memoryKey: string | null
  content: string
  status: MemoryStatusDto
  explicitness: MemoryExplicitnessDto
  evidenceCount: number
  /** 来源摘要：来源文件相对路径，无绑定来源时为来源类型 */
  sourceSummary: string
  createdAt: number
  updatedAt: number
}

export interface MemoryListRecordsParams {
  scopeKind: MemoryScopeKindDto
  /**
   * project scope 由主进程按当前工作区解析，传入值仅用于归属校验；
   * global scope 的 scopeId 固定，无需传入。
   */
  scopeId?: string
  /** 默认 active */
  status?: MemoryStatusDto
}

export interface MemoryRetractRecordParams {
  id: string
  scopeKind: MemoryScopeKindDto
}
