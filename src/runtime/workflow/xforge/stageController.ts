/**
 * StageController 纯函数骨架：合法转换、门禁夹紧、预算与终态冻结。
 *
 * 本窄纵切不执行 Agent、不写工作区、不挂 RunCoordinator；只约束转移是否允许。
 */

import {
  DELIVERY_TEST_FIX_BUDGET,
  REVIEW_REMEDIATION_BUDGET,
  SCOPE_CORRECTION_BUDGET,
  XFORGE_TERMINAL_STAGES,
  type StageControllerContext,
  type StageTransitionResult,
  type TransitionRejectCode,
  type XForgeStage,
  type XForgeTerminalStage
} from './types'

/**
 * 业务阶段合法后继（不含任意非终态 → waiting_user|failed|cancelled，见 isLegalTransition）。
 */
const BUSINESS_TRANSITIONS: Readonly<Partial<Record<XForgeStage, readonly XForgeStage[]>>> = {
  resolve: ['brainstorm', 'plan', 'scope_check', 'implement', 'test', 'review', 'completed'],
  brainstorm: ['plan'],
  plan: ['scope_check'],
  scope_check: ['plan', 'implement', 'waiting_user'],
  implement: ['test'],
  test: ['fix', 'review', 'waiting_user'],
  review: ['fix', 'report'],
  fix: ['test', 'plan'],
  report: ['completed'],
  waiting_user: []
}

const TERMINAL_SET = new Set<XForgeStage>(XFORGE_TERMINAL_STAGES)

export function isTerminalStage(stage: XForgeStage): stage is XForgeTerminalStage {
  return TERMINAL_SET.has(stage)
}

/**
 * 基础合法转换：业务表 ∪（任意非终态 → waiting_user|failed|cancelled）。
 * 终态无出边。
 */
export function isLegalTransition(from: XForgeStage, to: XForgeStage): boolean {
  if (isTerminalStage(from)) return false
  if (to === 'waiting_user' || to === 'failed' || to === 'cancelled') return true
  const allowed = BUSINESS_TRANSITIONS[from]
  return allowed !== undefined && allowed.includes(to)
}

function reject(
  from: XForgeStage,
  requestedTo: XForgeStage,
  code: TransitionRejectCode,
  reason: string
): StageTransitionResult {
  return { ok: false, from, requestedTo, code, reason }
}

function accept(
  from: XForgeStage,
  to: XForgeStage,
  reason: string,
  opts?: {
    requestedTo?: XForgeStage
    budgetDelta?: NonNullable<Extract<StageTransitionResult, { ok: true }>['budgetDelta']>
  }
): StageTransitionResult {
  return {
    ok: true,
    from,
    to,
    reason,
    ...(opts?.requestedTo !== undefined && opts.requestedTo !== to
      ? { requestedTo: opts.requestedTo }
      : {}),
    ...(opts?.budgetDelta ? { budgetDelta: opts.budgetDelta } : {})
  }
}

/**
 * 将指向 implement 的请求夹紧到满足 Validated Plan / Scope Pass 的阶段。
 *
 * 泛用 transition 始终要求两者齐备；Scope Gate 刚通过签发 Pass 的路径只走 nextAfterScopeCheck。
 */
export function clampImplementTarget(
  to: XForgeStage,
  facts: Pick<StageControllerContext, 'hasValidatedPlan' | 'hasValidScopePass'>
): XForgeStage {
  if (to !== 'implement') return to
  if (!facts.hasValidatedPlan) return 'plan'
  if (!facts.hasValidScopePass) return 'scope_check'
  return 'implement'
}

/**
 * 通用阶段转移：终态冻结 → 门禁夹紧 → 合法表校验 → reviewOnly 禁 fix。
 */
export function transition(
  ctx: StageControllerContext,
  to: XForgeStage
): StageTransitionResult {
  if (isTerminalStage(ctx.currentStage)) {
    return reject(
      ctx.currentStage,
      to,
      'terminal_frozen',
      `终态 ${ctx.currentStage} 不可被后续事件复活`
    )
  }

  const clamped = clampImplementTarget(to, ctx)

  if (ctx.reviewOnly && clamped === 'fix') {
    return reject(
      ctx.currentStage,
      to,
      'review_only_forbids_fix',
      'reviewOnly 禁止进入 fix'
    )
  }

  if (!isLegalTransition(ctx.currentStage, clamped)) {
    return reject(
      ctx.currentStage,
      to,
      'illegal_transition',
      `非法转换 ${ctx.currentStage} → ${clamped}`
    )
  }

  if (clamped !== to) {
    return accept(ctx.currentStage, clamped, `门禁夹紧 ${to} → ${clamped}`, {
      requestedTo: to
    })
  }

  return accept(ctx.currentStage, clamped, `允许 ${ctx.currentStage} → ${clamped}`)
}

/**
 * scope_check 完成后的下一跳。
 * HIGH 且预算未用尽 → plan（计数 +1）；第 2 轮后仍 HIGH → waiting_user；无 HIGH → implement。
 */
export function nextAfterScopeCheck(
  ctx: StageControllerContext,
  hasHigh: boolean
): StageTransitionResult {
  if (ctx.currentStage !== 'scope_check') {
    return reject(
      ctx.currentStage,
      hasHigh ? 'plan' : 'implement',
      'illegal_transition',
      `nextAfterScopeCheck 要求当前阶段为 scope_check，实际为 ${ctx.currentStage}`
    )
  }

  if (hasHigh) {
    if (ctx.scopeCorrectionUsed >= SCOPE_CORRECTION_BUDGET) {
      return accept(
        ctx.currentStage,
        'waiting_user',
        `Scope 修正预算已用尽（${SCOPE_CORRECTION_BUDGET}）且仍有 HIGH`
      )
    }
    return accept(ctx.currentStage, 'plan', 'Scope HIGH，进入计划修正', {
      budgetDelta: { scopeCorrection: 1 }
    })
  }

  if (!ctx.hasValidatedPlan) {
    return accept(ctx.currentStage, 'plan', '无 Validated Plan，无法进入 implement', {
      requestedTo: 'implement'
    })
  }

  return accept(
    ctx.currentStage,
    'implement',
    'Scope 通过并签发 Scope Pass 后进入 implement'
  )
}

/**
 * test 完成后的下一跳。
 * 通过 → review；失败且预算未尽 → fix（计数 +1）；预算耗尽 → waiting_user。
 */
export function nextAfterTest(
  ctx: StageControllerContext,
  passed: boolean
): StageTransitionResult {
  if (ctx.currentStage !== 'test') {
    return reject(
      ctx.currentStage,
      passed ? 'review' : 'fix',
      'illegal_transition',
      `nextAfterTest 要求当前阶段为 test，实际为 ${ctx.currentStage}`
    )
  }

  if (passed) {
    return transition(ctx, 'review')
  }

  if (ctx.deliveryTestFixUsed >= DELIVERY_TEST_FIX_BUDGET) {
    return accept(
      ctx.currentStage,
      'waiting_user',
      `交付 Test-Fix 预算已用尽（${DELIVERY_TEST_FIX_BUDGET}）`
    )
  }

  return accept(ctx.currentStage, 'fix', '测试未通过，进入交付修复', {
    budgetDelta: { deliveryTestFix: 1 }
  })
}

/**
 * review 完成后的下一跳。
 * reviewOnly → report；Blocking 且预算未尽 → fix；预算耗尽 → waiting_user；无 Blocking → report。
 */
export function nextAfterReview(
  ctx: StageControllerContext,
  hasBlocking: boolean
): StageTransitionResult {
  if (ctx.currentStage !== 'review') {
    return reject(
      ctx.currentStage,
      hasBlocking ? 'fix' : 'report',
      'illegal_transition',
      `nextAfterReview 要求当前阶段为 review，实际为 ${ctx.currentStage}`
    )
  }

  if (ctx.reviewOnly) {
    return transition(ctx, 'report')
  }

  if (hasBlocking) {
    if (ctx.reviewRemediationUsed >= REVIEW_REMEDIATION_BUDGET) {
      return accept(
        ctx.currentStage,
        'waiting_user',
        `Review Remediation 预算已用尽（${REVIEW_REMEDIATION_BUDGET}）`
      )
    }
    return accept(ctx.currentStage, 'fix', 'Blocking Findings，进入审查修复', {
      budgetDelta: { reviewRemediation: 1 }
    })
  }

  return transition(ctx, 'report')
}

/**
 * fix 完成后的下一跳。
 * 扩大 Validated Plan 范围 → plan；否则 → test。
 */
export function nextAfterFix(
  ctx: StageControllerContext,
  expandsScope: boolean
): StageTransitionResult {
  if (ctx.currentStage !== 'fix') {
    return reject(
      ctx.currentStage,
      expandsScope ? 'plan' : 'test',
      'illegal_transition',
      `nextAfterFix 要求当前阶段为 fix，实际为 ${ctx.currentStage}`
    )
  }
  return transition(ctx, expandsScope ? 'plan' : 'test')
}
