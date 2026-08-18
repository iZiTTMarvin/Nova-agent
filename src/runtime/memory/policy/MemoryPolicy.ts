/**
 * MemoryPolicy — 候选 → 落库决策的纯函数（零 IO、零时钟/随机依赖）。
 *
 * 等价判定：keyed 同 (scope, kind, key) 为同族，族内按规范化内容相似度区分 MERGE
 * （等价合并）与 SUPERSEDE（可变事实改写）；keyless 在同 (scope, kind) 内直接用相似度。
 * 显式优先（current vs previous 双视角）：current user explicit > workspace verified
 * > previous user explicit > repeated observed > inferred。低优先级候选不得改写高优先级
 * 既有记录；同优先级时要求新候选置信度不低于既有记录才允许替代。
 */
import { GLOBAL_SCOPE_ID } from '../MemoryPaths'
import {
  MEMORY_CONFIDENCE_CAP,
  MEMORY_CONFIDENCE_STEP,
  MEMORY_CONTENT_EQUIVALENCE_THRESHOLD,
  MEMORY_INFERRED_MIN_CONFIDENCE,
  MEMORY_PROMOTION_GLOBAL_MIN_PROJECTS,
  MEMORY_PROMOTION_PROJECT_MIN_SESSIONS
} from '../memoryConfig'
import type {
  Explicitness,
  MemoryCandidate,
  MemoryCandidateEvidence,
  MemoryPolicyContext,
  MemoryPolicyDecision,
  MemoryPolicyReason,
  MemoryPolicyRecordDraft,
  MemoryPolicyRelatedRecord,
  MemoryScope
} from '../types'

// 冲突优先级区分「当前候选」与「既有记录」两个视角：工作区现状高于历史用户表态，
// 当前用户表态高于一切；observed/inferred 两个视角同权。
const CANDIDATE_EXPLICITNESS_RANK: Readonly<Record<Explicitness, number>> = {
  user_explicit: 4,
  workspace_verified: 3,
  observed: 1,
  inferred: 0
}

const EXISTING_EXPLICITNESS_RANK: Readonly<Record<Explicitness, number>> = {
  user_explicit: 2,
  workspace_verified: 3,
  observed: 1,
  inferred: 0
}

/**
 * 候选落点 scope：project_hint 恒为当前项目；global 提示只在证据支持跨项目语义时保留。
 * project_fact 永远是项目事实；全部证据均为 workspace 文件事实时同样不足以支撑 global。
 */
export function resolveCandidateScope(
  candidate: MemoryCandidate,
  projectScopeId: string
): MemoryScope {
  if (candidate.scopeHint !== 'global') {
    return { scopeKind: 'project', scopeId: projectScopeId }
  }
  const allWorkspaceEvidence =
    candidate.evidence.length > 0 && candidate.evidence.every((e) => e.type === 'workspace')
  if (candidate.kind === 'project_fact' || allWorkspaceEvidence) {
    return { scopeKind: 'project', scopeId: projectScopeId }
  }
  return { scopeKind: 'global', scopeId: GLOBAL_SCOPE_ID }
}

export function decideMemoryPolicy(
  candidate: MemoryCandidate,
  ctx: MemoryPolicyContext
): MemoryPolicyDecision {
  if (candidate.evidence.length === 0) {
    return ignoreDecision('no-evidence')
  }

  const scope = resolveCandidateScope(candidate, ctx.projectScopeId)
  const family = familyRecords(candidate, ctx.relatedRecords, scope)

  if (candidate.intent === 'negate') {
    return decideNegate(candidate, scope, family)
  }
  return decideAssert(candidate, scope, family, ctx)
}

// ---------------------------------------------------------------------------
// 内容相似度（keyless 等价与 keyed 族内比对共用的确定性度量）
// ---------------------------------------------------------------------------

/** 规范化 char-bigram Jaccard：CJK 与拉丁文本均可用，同输入同输出 */
export function contentSimilarity(a: string, b: string): number {
  const ga = charGrams(normalizeForSimilarity(a))
  const gb = charGrams(normalizeForSimilarity(b))
  if (ga.size === 0 || gb.size === 0) {
    return 0
  }
  let intersection = 0
  for (const gram of ga) {
    if (gb.has(gram)) {
      intersection += 1
    }
  }
  const union = ga.size + gb.size - intersection
  return union === 0 ? 0 : intersection / union
}

function isEquivalentContent(a: string, b: string): boolean {
  return contentSimilarity(a, b) >= MEMORY_CONTENT_EQUIVALENCE_THRESHOLD
}

function normalizeForSimilarity(text: string): string {
  return text.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
}

function charGrams(text: string): Set<string> {
  const grams = new Set<string>()
  if (text.length === 0) {
    return grams
  }
  if (text.length === 1) {
    grams.add(text)
    return grams
  }
  for (let i = 0; i + 1 < text.length; i += 1) {
    grams.add(text.slice(i, i + 2))
  }
  return grams
}

// ---------------------------------------------------------------------------
// 决策主路径
// ---------------------------------------------------------------------------

function familyRecords(
  candidate: MemoryCandidate,
  related: readonly MemoryPolicyRelatedRecord[],
  scope: MemoryScope
): MemoryPolicyRelatedRecord[] {
  return related.filter((item) => {
    const rec = item.record
    if (rec.scopeKind !== scope.scopeKind || rec.scopeId !== scope.scopeId) {
      return false
    }
    if (rec.kind !== candidate.kind) {
      return false
    }
    if (candidate.memoryKey === null) {
      return rec.memoryKey === null
    }
    return rec.memoryKey === candidate.memoryKey
  })
}

/** 既有 active/pending 目标，active 优先（supersede / retract 的落点） */
function liveTargets(family: readonly MemoryPolicyRelatedRecord[]): MemoryPolicyRelatedRecord[] {
  return family
    .filter((item) => item.record.status === 'active' || item.record.status === 'pending')
    .sort((a, b) => statusRank(b.record.status) - statusRank(a.record.status))
}

function statusRank(status: MemoryPolicyRelatedRecord['record']['status']): number {
  return status === 'active' ? 1 : 0
}

function decideNegate(
  candidate: MemoryCandidate,
  scope: MemoryScope,
  family: readonly MemoryPolicyRelatedRecord[]
): MemoryPolicyDecision {
  const targets = liveTargets(family)

  if (candidate.memoryKey === null) {
    const target = targets.find((item) =>
      isEquivalentContent(candidate.content, item.record.content)
    )
    if (!target) {
      return ignoreDecision('negate-no-target')
    }
    return { operation: 'RETRACT', reason: 'negate-retract', targetId: target.record.id }
  }

  const target = targets[0]
  if (!target) {
    return ignoreDecision('negate-no-target')
  }
  if (isEquivalentContent(candidate.content, target.record.content)) {
    return { operation: 'RETRACT', reason: 'negate-retract', targetId: target.record.id }
  }
  // 否定并给出新内容：按 SUPERSEDE 语义替换（仍受 rank 规则约束）
  return supersedeOrDefer(candidate, target, scope, 'negate-replace')
}

function decideAssert(
  candidate: MemoryCandidate,
  scope: MemoryScope,
  family: readonly MemoryPolicyRelatedRecord[],
  ctx: MemoryPolicyContext
): MemoryPolicyDecision {
  const targets = liveTargets(family)

  const equivalent = targets.find((item) =>
    isEquivalentContent(candidate.content, item.record.content)
  )
  if (equivalent) {
    return mergeDecision(candidate, equivalent, ctx)
  }

  // 已撤回/已被替代的记忆不得被动复活；用户当前明确重申等价内容时除外，
  // 走正常路径改写或新增（旧行保持终态以保留审计链）
  const deadEquivalent = family.some(
    (item) =>
      (item.record.status === 'retracted' || item.record.status === 'superseded') &&
      isEquivalentContent(candidate.content, item.record.content)
  )
  if (deadEquivalent && candidate.explicitness !== 'user_explicit') {
    return ignoreDecision('equivalent-retracted')
  }

  if (candidate.memoryKey !== null) {
    const target = targets[0]
    if (target) {
      return supersedeOrDefer(candidate, target, scope, 'mutable-fact-superseded')
    }
  }

  return addDecision(candidate, scope, false)
}

function supersedeOrDefer(
  candidate: MemoryCandidate,
  target: MemoryPolicyRelatedRecord,
  scope: MemoryScope,
  reason: 'mutable-fact-superseded' | 'negate-replace'
): MemoryPolicyDecision {
  const newRank = CANDIDATE_EXPLICITNESS_RANK[candidate.explicitness]
  const oldRank = EXISTING_EXPLICITNESS_RANK[target.record.explicitness]
  const sameRankReliable =
    newRank === oldRank && candidate.confidence >= target.record.confidence

  if (newRank < oldRank || (newRank === oldRank && !sameRankReliable)) {
    // 低 rank / 同 rank 低置信不得改写既有记录，只能缓行为 pending 或忽略
    if (
      candidate.explicitness === 'inferred' &&
      candidate.confidence < MEMORY_INFERRED_MIN_CONFIDENCE
    ) {
      return ignoreDecision('inferred-below-threshold')
    }
    return addDecision(candidate, scope, true)
  }

  return {
    operation: 'SUPERSEDE',
    reason,
    targetId: target.record.id,
    draft: buildDraft(candidate, scope, 'active')
  }
}

/** conflict=true 表示与更强既有记录冲突，只允许缓行为 pending */
function addDecision(
  candidate: MemoryCandidate,
  scope: MemoryScope,
  conflict: boolean
): MemoryPolicyDecision {
  if (
    candidate.explicitness === 'inferred' &&
    candidate.confidence < MEMORY_INFERRED_MIN_CONFIDENCE
  ) {
    return ignoreDecision('inferred-below-threshold')
  }

  const strong =
    candidate.explicitness === 'user_explicit' ||
    candidate.explicitness === 'workspace_verified'
  const status: 'active' | 'pending' = conflict || !strong ? 'pending' : 'active'
  const reason = conflict
    ? 'conflict-pending'
    : strong
      ? 'strong-evidence-active'
      : candidate.explicitness === 'observed'
        ? 'observed-pending'
        : 'inferred-pending'

  return { operation: 'ADD', reason, draft: buildDraft(candidate, scope, status) }
}

function mergeDecision(
  candidate: MemoryCandidate,
  target: MemoryPolicyRelatedRecord,
  ctx: MemoryPolicyContext
): MemoryPolicyDecision {
  const record = target.record

  const sessions = new Set(target.evidenceSessionIds)
  for (const evidence of candidate.evidence) {
    if (evidence.sessionId) {
      sessions.add(evidence.sessionId)
    }
  }
  sessions.add(ctx.sessionId)

  const projects = new Set(target.evidenceProjectScopeIds)
  projects.add(ctx.projectScopeId)

  // 历史计数可能来自无证据行的旧行，取 max 保证计数只增不减
  const distinctSessionCount = Math.max(record.distinctSessionCount, sessions.size)
  const distinctProjectCount = Math.max(record.distinctProjectCount, projects.size)

  const confidence =
    record.confidence >= MEMORY_CONFIDENCE_CAP
      ? record.confidence
      : roundConfidence(Math.min(MEMORY_CONFIDENCE_CAP, record.confidence + MEMORY_CONFIDENCE_STEP))

  const promote =
    record.status === 'pending' &&
    promotionSatisfied(record, candidate, distinctSessionCount, distinctProjectCount)

  return {
    operation: 'MERGE',
    reason: promote ? 'equivalent-merge-promoted' : 'equivalent-merge',
    targetId: record.id,
    evidence: candidate.evidence,
    confidence,
    distinctSessionCount,
    distinctProjectCount,
    promote
  }
}

/** observed/inferred 缓行记录的晋升门槛；用户明确表达或工作区可证的新证据可直接晋升 */
function promotionSatisfied(
  record: MemoryPolicyRelatedRecord['record'],
  candidate: MemoryCandidate,
  distinctSessionCount: number,
  distinctProjectCount: number
): boolean {
  if (record.explicitness !== 'observed' && record.explicitness !== 'inferred') {
    return false
  }
  const strongNewEvidence =
    candidate.explicitness === 'user_explicit' ||
    candidate.explicitness === 'workspace_verified'
  if (record.scopeKind === 'global') {
    return distinctProjectCount >= MEMORY_PROMOTION_GLOBAL_MIN_PROJECTS || strongNewEvidence
  }
  return distinctSessionCount >= MEMORY_PROMOTION_PROJECT_MIN_SESSIONS || strongNewEvidence
}

function buildDraft(
  candidate: MemoryCandidate,
  scope: MemoryScope,
  status: 'active' | 'pending'
): MemoryPolicyRecordDraft {
  const primaryEvidence: MemoryCandidateEvidence = candidate.evidence[0]
  return {
    scope,
    kind: candidate.kind,
    memoryKey: candidate.memoryKey,
    content: candidate.content,
    status,
    confidence: candidate.confidence,
    explicitness: candidate.explicitness,
    sourceType: primaryEvidence.type,
    sourcePath: candidate.evidence.find((e) => e.sourcePath)?.sourcePath ?? null,
    evidence: candidate.evidence
  }
}

function ignoreDecision(reason: MemoryPolicyReason): MemoryPolicyDecision {
  return { operation: 'IGNORE', reason }
}

function roundConfidence(value: number): number {
  return Math.round(value * 10000) / 10000
}
