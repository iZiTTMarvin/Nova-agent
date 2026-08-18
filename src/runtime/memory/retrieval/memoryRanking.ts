/**
 * 确定性 rerank 纯函数：零 IO、零时钟依赖（now 由调用方注入）、同输入同序。
 * 「最近创建」不参与排序；陈旧只影响 mutable 类（project_fact）。
 */
import type { Explicitness, MemoryKind } from '../types'
import type { ScoredMemoryResult } from './MemoryRetriever'

/** 各因子权重（和为 1）；调整即改变检索排序契约，须连同 ranking 测试评估 */
export const MEMORY_RANKING_WEIGHTS = {
  lexical: 0.4,
  scopeTier: 0.25,
  explicitness: 0.12,
  confidence: 0.08,
  kindRelevance: 0.08,
  freshness: 0.07
} as const

/** scope 优先级分档：project structured > manual doc > global explicit > global advisory > episodic */
const SCOPE_TIER_PROJECT_STRUCTURED = 4
const SCOPE_TIER_MANUAL_DOC = 3
const SCOPE_TIER_GLOBAL_EXPLICIT = 2
const SCOPE_TIER_GLOBAL_ADVISORY = 1
const SCOPE_TIER_EPISODIC = 0
const SCOPE_TIER_MAX = SCOPE_TIER_PROJECT_STRUCTURED

const EXPLICITNESS_RANK: Readonly<Record<Explicitness, number>> = {
  user_explicit: 1,
  workspace_verified: 0.85,
  observed: 0.6,
  inferred: 0.4
}

/** 手写文档可信度类比用户显式表达；文档无 confidence 列 */
const DOCUMENT_EXPLICITNESS_SCORE = 0.9
const DOCUMENT_CONFIDENCE_SCORE = 0.8

/** project_fact 的 last_seen_at 衰减半衰期（天）；preference/decision/gotcha 等稳定类型不衰减 */
export const MEMORY_FRESHNESS_HALF_LIFE_DAYS = 90

const MS_PER_DAY = 86_400_000

/** kind 相关性词典命中得 1，未命中中性 0.5；仅作轻量加权，不做语义理解 */
const KIND_RELEVANCE_HIT = 1
const KIND_RELEVANCE_NEUTRAL = 0.5

const QUERY_KIND_LEXICON: Readonly<Record<MemoryKind, readonly string[]>> = {
  preference: ['偏好', '喜欢', '习惯', 'prefer', 'like'],
  convention: ['约定', '规范', '命名', 'convention', 'naming'],
  project_fact: ['用什么', '使用', '版本', '技术栈', 'fact', 'version', 'stack'],
  decision: ['决策', '为什么', '选型', '决定', 'decision', 'chose', 'why'],
  workflow: ['流程', '步骤', '怎么做', 'workflow', 'process'],
  gotcha: ['坑', '踩坑', '教训', '注意', 'gotcha', 'pitfall', 'mistake']
}

/** episodic 文档目录前缀（与 MemoryConsolidator 落盘约定一致） */
const EPISODIC_REL_PATH_PREFIX = 'episodic/'

export function isEpisodicDocument(result: { group: string; relPath?: string }): boolean {
  return result.group === 'document' && (result.relPath ?? '').startsWith(EPISODIC_REL_PATH_PREFIX)
}

/** scope 分档（0..4），归一后作为 scopeTier 因子 */
export function scopeTierOf(result: ScoredMemoryResult): number {
  if (result.group === 'structured-project') {
    return SCOPE_TIER_PROJECT_STRUCTURED
  }
  if (result.group === 'document') {
    return isEpisodicDocument(result) ? SCOPE_TIER_EPISODIC : SCOPE_TIER_MANUAL_DOC
  }
  return result.explicitness === 'user_explicit' || result.explicitness === 'workspace_verified'
    ? SCOPE_TIER_GLOBAL_EXPLICIT
    : SCOPE_TIER_GLOBAL_ADVISORY
}

function explicitnessScore(result: ScoredMemoryResult): number {
  return result.group === 'document' ? DOCUMENT_EXPLICITNESS_SCORE : EXPLICITNESS_RANK[result.explicitness]
}

function confidenceScore(result: ScoredMemoryResult): number {
  return result.group === 'document' ? DOCUMENT_CONFIDENCE_SCORE : clampUnit(result.confidence)
}

export function kindRelevanceScore(query: string, kind: MemoryKind | 'document'): number {
  if (kind === 'document') {
    return KIND_RELEVANCE_NEUTRAL
  }
  const lowered = query.toLowerCase()
  return QUERY_KIND_LEXICON[kind].some((word) => lowered.includes(word.toLowerCase()))
    ? KIND_RELEVANCE_HIT
    : KIND_RELEVANCE_NEUTRAL
}

/** 陈旧衰减只作用于 project_fact；其余 kind 不因年代降权 */
export function freshnessScore(result: ScoredMemoryResult, now: number): number {
  if (result.group === 'document' || result.kind !== 'project_fact') {
    return 1
  }
  const ageMs = Math.max(0, now - result.lastSeenAt)
  return Math.exp(-ageMs / (MEMORY_FRESHNESS_HALF_LIFE_DAYS * MS_PER_DAY))
}

export function computeMemoryRankScore(result: ScoredMemoryResult, query: string, now: number): number {
  const w = MEMORY_RANKING_WEIGHTS
  return (
    w.lexical * clampUnit(result.lexicalScore)
    + w.scopeTier * (scopeTierOf(result) / SCOPE_TIER_MAX)
    + w.explicitness * explicitnessScore(result)
    + w.confidence * confidenceScore(result)
    + w.kindRelevance * kindRelevanceScore(query, result.kind)
    + w.freshness * freshnessScore(result, now)
  )
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) {
    return 0
  }
  return Math.min(1, Math.max(0, value))
}

/**
 * 确定性排序 + 多样性去重：
 * 按综合分降序；同分以 id 升序兜底保证全序；同 (group, kind, key) 只保最高分。
 * 历史记录（superseded/retracted/needs_verification）不参与去重：
 * 它们与继任记录同 key 是常态，history 检索必须保留完整追溯链。
 */
export function rankMemoryResults(
  results: readonly ScoredMemoryResult[],
  query: string,
  now: number
): ScoredMemoryResult[] {
  const scored = results
    .map((result) => ({ result, score: computeMemoryRankScore(result, query, now) }))
    .sort((a, b) => (a.score !== b.score ? b.score - a.score : compareId(a.result.id, b.result.id)))

  const seenKeys = new Set<string>()
  const ranked: ScoredMemoryResult[] = []
  for (const item of scored) {
    const key = dedupeKey(item.result)
    if (key !== null) {
      if (seenKeys.has(key)) {
        continue
      }
      seenKeys.add(key)
    }
    ranked.push(item.result)
  }
  return ranked
}

/** keyed 结构化记录的多样性键；keyless、文档与历史记录不去重 */
function dedupeKey(result: ScoredMemoryResult): string | null {
  if (result.group === 'document' || result.memoryKey === null || result.historicalNote !== null) {
    return null
  }
  return `${result.group}:${result.kind}:${result.memoryKey}`
}

function compareId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
