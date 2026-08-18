/**
 * 检索端口与结果契约：结构化/文档/未来 vector 检索共用单一 search 入口。
 * 结果类型面向渲染与注入消费，不携带内部排序分；排序分只存在于 Scored 变体，
 * 且在组合层出口被剥离，禁止进入工具输出或注入块。
 */
import type { Explicitness, MemoryKind, MemoryStatus } from '../types'

/** history 检索带出的状态标注；默认检索只回 active，恒为 null */
export type MemoryHistoricalNote = 'superseded' | 'retracted' | 'needs-verification'

interface MemoryResultBase {
  /** 结构化记录为记录 id；文档命中为 scope 内 relPath */
  id: string
  /** observed 偏好只是背景参考，渲染层必须带 advisory 标注 */
  advisory: boolean
  historicalNote: MemoryHistoricalNote | null
}

/** 结构化记忆命中（memory_records） */
export interface StructuredMemoryResult extends MemoryResultBase {
  group: 'structured-project' | 'structured-global'
  kind: MemoryKind
  content: string
  status: MemoryStatus
  explicitness: Explicitness
  confidence: number
  memoryKey: string | null
  lastSeenAt: number
  /** 懒校验所需的来源绑定；仅供 lifecycle 消费，禁止渲染 */
  source: { path: string; fingerprint: string } | null
}

/** 文档记忆命中（MEMORY.md / 手写 .md / episodic） */
export interface DocumentMemoryResult extends MemoryResultBase {
  group: 'document'
  kind: 'document'
  relPath: string
  /** 完整正文；渲染前经 excerpt 提取 */
  body: string
}

export type MemorySearchResult = StructuredMemoryResult | DocumentMemoryResult

/** 排序内部变体：携带池内归一化 lexical 分（top = 1） */
export type ScoredMemoryResult = MemorySearchResult & { lexicalScore: number }

export interface MemorySearchInput {
  query: string
  projectScopeId: string
  /** source-bound 记录懒校验用；缺省跳过校验 */
  workspaceRoot?: string
  /** true 时允许 superseded / retracted / needs_verification 参与并带标注 */
  history?: boolean
  limit?: number
  scoreFloor?: number
}

export interface MemoryRetriever {
  search(input: MemorySearchInput): Promise<ScoredMemoryResult[]>
}

/**
 * vector 检索扩展点：provider 可缺省（null），缺失时组合层只走 FTS，不产生错误。
 * 在通过评测消融验证前不得提供实现。
 */
export interface MemoryVectorProvider {
  isAvailable(): boolean
  embed(text: string): Promise<Float32Array>
}

/** 剥离排序分，得到对模型侧可见的结果形状 */
export function stripLexicalScore(result: ScoredMemoryResult): MemorySearchResult {
  const { lexicalScore: _lexical, ...rest } = result
  return rest
}
