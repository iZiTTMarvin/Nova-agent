/**
 * NovaMemEval 评测装置：case 契约、指标计算与百分位工具。
 * 数据集与运行器见 evalCases.ts / novaMemEval.test.ts；本文件不含具体用例。
 */

export type EvalCategory =
  | 'global-explicit-preference'
  | 'global-observed-preference'
  | 'project-decision-convention'
  | 'gotcha-workflow'
  | 'conflict-supersede-retract'
  | 'project-scope-isolation'
  | 'irrelevant-abstention'
  | 'history-query'

export type EvalPerspective = 'project-a' | 'project-b'

export type EvalBehavior = 'return_current' | 'return_history' | 'abstain'

export interface EvalCase {
  id: string
  category: EvalCategory
  /** 以哪个项目的视角检索 */
  perspective: EvalPerspective
  query: string
  /** history=true 允许 superseded/retracted 参与并带标注 */
  history?: boolean
  /** top-K（K=5）内必须全部出现；abstention 用例为空数组 */
  expectedMemoryIds: readonly string[]
  /** 结果中不允许出现的记忆（旧事实 / 他项目 / 已撤回） */
  forbiddenMemoryIds: readonly string[]
  expectedBehavior: EvalBehavior
}

export interface EvalCaseOutcome {
  caseId: string
  category: EvalCategory
  /** 返回的 top-5 记忆 id */
  returnedIds: readonly string[]
  expectedHits: readonly string[]
  /** 首个命中目标记忆的排名（1 起）；未命中为 null */
  firstExpectedRank: number | null
  /** 禁止记忆是否出现在结果中 */
  forbiddenLeak: readonly string[]
  durationMs: number
}

export interface EvalMetrics {
  caseCount: number
  recallAt1: number
  recallAt5: number
  mrr: number
  /** 默认检索返回过期记忆的用例占比（history 用例不计入） */
  staleRate: number
  /** 跨项目记忆泄漏的用例占比 */
  scopeLeakageRate: number
  /** 默认检索返回已撤回记忆的用例占比 */
  retractedLeakRate: number
  /** abstention 用例中结果为空的占比（目标：高） */
  abstentionPrecision: number
  latency: { p50: number; p95: number; p99: number }
}

const TOP_K = 5

export function evaluateOutcome(evalCase: EvalCase, returnedIds: readonly string[], durationMs: number): EvalCaseOutcome {
  const expected = evalCase.expectedMemoryIds
  const returnedTop = returnedIds.slice(0, TOP_K)
  const expectedHits = expected.filter((id) => returnedTop.includes(id))
  const firstExpectedRank = expected.length
    ? (returnedTop.findIndex((id) => expected.includes(id)) + 1) || null
    : null
  return {
    caseId: evalCase.id,
    category: evalCase.category,
    returnedIds: returnedTop,
    expectedHits,
    firstExpectedRank: firstExpectedRank && firstExpectedRank > 0 ? firstExpectedRank : null,
    forbiddenLeak: evalCase.forbiddenMemoryIds.filter((id) => returnedTop.includes(id)),
    durationMs
  }
}

export function computeMetrics(outcomes: readonly EvalCaseOutcome[], evalCases: readonly EvalCase[]): EvalMetrics {
  const byId = new Map(evalCases.map((c) => [c.id, c]))
  const ranked = outcomes.filter((o) => o.expectedHits.length >= 0 && byId.get(o.caseId)!.expectedMemoryIds.length > 0)

  const recallAt1Pass = ranked.filter((o) => o.firstExpectedRank === 1).length
  const recallAt5Pass = ranked.filter(
    (o) => byId.get(o.caseId)!.expectedMemoryIds.every((id) => o.returnedIds.includes(id))
  ).length
  const reciprocalSum = ranked.reduce((acc, o) => acc + (o.firstExpectedRank ? 1 / o.firstExpectedRank : 0), 0)

  const defaultOutcomes = outcomes.filter((o) => byId.get(o.caseId)!.history !== true)
  const staleCount = defaultOutcomes.filter((o) => o.forbiddenLeak.length > 0).length
  const retractedCount = defaultOutcomes.filter((o) =>
    o.forbiddenLeak.some((id) => id.includes('_r_') || id.startsWith('cfr_'))
  ).length
  const leakageCount = outcomes.filter((o) => o.forbiddenLeak.length > 0 && byId.get(o.caseId)!.category === 'project-scope-isolation').length

  const abstentionOutcomes = outcomes.filter((o) => byId.get(o.caseId)!.expectedBehavior === 'abstention')
  const abstentionEmpty = abstentionOutcomes.filter((o) => o.returnedIds.length === 0).length

  const durations = outcomes.map((o) => o.durationMs).sort((a, b) => a - b)

  return {
    caseCount: outcomes.length,
    recallAt1: ranked.length ? recallAt1Pass / ranked.length : 0,
    recallAt5: ranked.length ? recallAt5Pass / ranked.length : 0,
    mrr: ranked.length ? reciprocalSum / ranked.length : 0,
    staleRate: defaultOutcomes.length ? staleCount / defaultOutcomes.length : 0,
    scopeLeakageRate: outcomes.length ? leakageCount / outcomes.length : 0,
    retractedLeakRate: defaultOutcomes.length ? retractedCount / defaultOutcomes.length : 0,
    abstentionPrecision: abstentionOutcomes.length ? abstentionEmpty / abstentionOutcomes.length : 1,
    latency: {
      p50: percentile(durations, 0.5),
      p95: percentile(durations, 0.95),
      p99: percentile(durations, 0.99)
    }
  }
}

export function percentile(sortedAsc: readonly number[], p: number): number {
  if (sortedAsc.length === 0) {
    return 0
  }
  const idx = Math.min(sortedAsc.length - 1, Math.ceil(p * sortedAsc.length) - 1)
  return sortedAsc[Math.max(0, idx)]
}
