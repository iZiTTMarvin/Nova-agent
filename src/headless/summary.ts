/**
 * headless 轮次终态 → summary 字段的纯派生。
 * 与 cli.ts 的 main() 分离：cli.ts 在 import 时即启动 main()，无法直接单测；
 * 这里集中承载 budget_exhausted / failure_class / 退出码的判定口径。
 */
import type { IncompleteReason } from '../runtime/agent/turn'
import type { AgentEvent, RepairDiagnosticKind } from '../runtime/agent/types'

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

/** 修复分型汇总（repair.native_xml 等，写入 headless summary） */
export type RepairTotals = Record<RepairDiagnosticKind, number>

/** 修复后执行结果（每分型：成功 / 失败计数，用于发现"错误修复"反向伤害） */
export type RepairOutcomeTotals = {
  [K in RepairDiagnosticKind]: { success: number; failure: number }
}

/** 从事件流累计修复分型计数。纯函数，便于单测。 */
export function accumulateRepairTotals(events: AgentEvent[]): RepairTotals {
  const totals: RepairTotals = {
    native_xml: 0,
    empty_args_from_content: 0,
    unclosed_parameter: 0,
    type_coercion: 0,
    control_character: 0,
    tool_name_case: 0,
    shape_null_strip: 0,
    shape_array_repair: 0,
    shape_scalar_coercion: 0
  }
  for (const event of events) {
    if (event.type === 'repair_diagnostic') {
      totals[event.kind] += 1
    }
  }
  return totals
}

/**
 * 修复后执行结果：把 repair_diagnostic 按 toolCallId 关联到后续 tool_result，
 * 判定该工具调用最终成功 / 失败。同一 toolCallId 的多个分型共享同一执行结果。
 * 与 AgentEventAccumulator 的失败判定口径一致（工具执行失败 / 权限拒绝前缀）。
 */
export function accumulateRepairOutcomes(events: AgentEvent[]): RepairOutcomeTotals {
  const empty: { success: number; failure: number } = { success: 0, failure: 0 }
  const totals: RepairOutcomeTotals = {
    native_xml: { ...empty },
    empty_args_from_content: { ...empty },
    unclosed_parameter: { ...empty },
    type_coercion: { ...empty },
    control_character: { ...empty },
    tool_name_case: { ...empty },
    shape_null_strip: { ...empty },
    shape_array_repair: { ...empty },
    shape_scalar_coercion: { ...empty }
  }

  // toolCallId → 该调用涉及的修复分型（顺序无关，去重）
  const repairedKinds = new Map<string, Set<keyof RepairOutcomeTotals>>()
  for (const event of events) {
    if (event.type !== 'repair_diagnostic') continue
    const kinds = repairedKinds.get(event.toolCallId) ?? new Set<keyof RepairOutcomeTotals>()
    kinds.add(event.kind)
    repairedKinds.set(event.toolCallId, kinds)
  }
  if (repairedKinds.size === 0) return totals

  // toolCallId → 最终结果（以最后一个 tool_result 为准）
  const resultByCall = new Map<string, boolean>()
  for (const event of events) {
    if (event.type !== 'tool_result') continue
    // 失败前缀与 toolBatchExecutor 的失败文本拼接一致（均带冒号）：
    // 执行异常 / 权限拒绝 / hook 拦截都意味着工具未成功执行
    const isError =
      event.result.startsWith('工具执行失败:') ||
      event.result.startsWith('权限拒绝:') ||
      event.result.startsWith('工具被 hook 拦截:')
    resultByCall.set(event.toolCallId, !isError)
  }

  for (const [toolCallId, kinds] of repairedKinds) {
    const success = resultByCall.get(toolCallId)
    if (success === undefined) continue // 被取消/未执行：不计数
    for (const kind of kinds) {
      if (success) {
        totals[kind].success += 1
      } else {
        totals[kind].failure += 1
      }
    }
  }
  return totals
}
