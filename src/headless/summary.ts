/**
 * headless 轮次终态 → summary 字段的纯派生。
 * 与 cli.ts 的 main() 分离：cli.ts 在 import 时即启动 main()，无法直接单测；
 * 这里集中承载 budget_exhausted / failure_class / 退出码的判定口径。
 */
import type { IncompleteReason } from '../runtime/agent/turn'

export type HeadlessStatus = 'completed' | 'incomplete' | 'failed' | 'cancelled'

export type HeadlessTurnReport =
  | { status: 'completed'; deadlineReached: boolean }
  | { status: 'incomplete'; reason: IncompleteReason; deadlineReached: boolean }
  | { status: 'cancelled' | 'failed'; deadlineReached: boolean }

export interface HeadlessSummaryDerivation {
  /** budget 耗尽：deadline 到期，或 max_rounds 截断（与 DeepSWE 的 budget 语义一致） */
  budgetExhausted: boolean
  /** completed 为 null；incomplete 直接取截断原因；deadline 到期取消保持 budget_exhausted */
  failureClass: string | null
  /** 非 completed 且非 deadline 到期时退出码非零 */
  exitNonZero: boolean
}

/** 轮次终态 → summary 关键字段的唯一派生点 */
export function deriveHeadlessSummary(
  report: HeadlessTurnReport
): HeadlessSummaryDerivation {
  const budgetExhausted =
    report.deadlineReached ||
    (report.status === 'incomplete' && report.reason === 'max_rounds')

  let failureClass: string | null
  if (report.status === 'completed') {
    failureClass = null
  } else if (report.status === 'incomplete') {
    failureClass = report.reason
  } else if (report.status === 'cancelled') {
    failureClass = report.deadlineReached ? 'budget_exhausted' : 'agent_cancelled'
  } else {
    failureClass = 'agent_error'
  }

  return {
    budgetExhausted,
    failureClass,
    exitNonZero: report.status !== 'completed' && !report.deadlineReached
  }
}
