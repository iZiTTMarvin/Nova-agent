import { describe, expect, it } from 'vitest'
import {
  DELIVERY_TEST_FIX_BUDGET,
  REVIEW_REMEDIATION_BUDGET,
  SCOPE_CORRECTION_BUDGET,
  isLegalTransition,
  isTerminalStage,
  nextAfterFix,
  nextAfterReview,
  nextAfterScopeCheck,
  nextAfterTest,
  transition,
  type StageControllerContext,
  type XForgeStage
} from '../../../../../src/runtime/workflow/xforge'

function ctx(
  currentStage: XForgeStage,
  overrides: Partial<StageControllerContext> = {}
): StageControllerContext {
  return {
    currentStage,
    reviewOnly: false,
    hasValidatedPlan: true,
    hasValidScopePass: true,
    scopeCorrectionUsed: 0,
    deliveryTestFixUsed: 0,
    reviewRemediationUsed: 0,
    ...overrides
  }
}

describe('isLegalTransition / 合法转换表', () => {
  const legalPairs: Array<[XForgeStage, XForgeStage]> = [
    ['resolve', 'brainstorm'],
    ['resolve', 'plan'],
    ['resolve', 'scope_check'],
    ['resolve', 'implement'],
    ['resolve', 'test'],
    ['resolve', 'review'],
    ['resolve', 'completed'],
    ['brainstorm', 'plan'],
    ['plan', 'scope_check'],
    ['scope_check', 'plan'],
    ['scope_check', 'implement'],
    ['scope_check', 'waiting_user'],
    ['implement', 'test'],
    ['test', 'fix'],
    ['test', 'review'],
    ['test', 'waiting_user'],
    ['review', 'fix'],
    ['review', 'report'],
    ['fix', 'test'],
    ['fix', 'plan'],
    ['report', 'completed']
  ]

  it.each(legalPairs)('允许 %s → %s', (from, to) => {
    expect(isLegalTransition(from, to)).toBe(true)
  })

  it('任意非终态可进入 waiting_user / failed / cancelled', () => {
    for (const from of ['resolve', 'implement', 'review', 'waiting_user'] as XForgeStage[]) {
      expect(isLegalTransition(from, 'waiting_user')).toBe(true)
      expect(isLegalTransition(from, 'failed')).toBe(true)
      expect(isLegalTransition(from, 'cancelled')).toBe(true)
    }
  })

  it('拒绝非法业务转换', () => {
    expect(isLegalTransition('brainstorm', 'implement')).toBe(false)
    expect(isLegalTransition('plan', 'implement')).toBe(false)
    expect(isLegalTransition('implement', 'review')).toBe(false)
    expect(isLegalTransition('report', 'fix')).toBe(false)
  })
})

describe('transition', () => {
  it('非法转换拒绝并返回结构化原因', () => {
    const result = transition(ctx('brainstorm'), 'implement')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('illegal_transition')
      expect(result.from).toBe('brainstorm')
      expect(result.requestedTo).toBe('implement')
      expect(result.reason.length).toBeGreaterThan(0)
    }
  })

  it('reviewOnly 下禁止进入 fix', () => {
    const result = transition(ctx('review', { reviewOnly: true }), 'fix')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('review_only_forbids_fix')
    }
  })

  it('reviewOnly 下 review → report', () => {
    const result = transition(ctx('review', { reviewOnly: true }), 'report')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.to).toBe('report')
  })

  it('无 Validated Plan 时 implement 夹到 plan', () => {
    const result = transition(
      ctx('resolve', { hasValidatedPlan: false, hasValidScopePass: false }),
      'implement'
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.to).toBe('plan')
      expect(result.requestedTo).toBe('implement')
    }
  })

  it('无 Scope Pass 时 implement 夹到 scope_check', () => {
    const result = transition(
      ctx('resolve', { hasValidatedPlan: true, hasValidScopePass: false }),
      'implement'
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.to).toBe('scope_check')
      expect(result.requestedTo).toBe('implement')
    }
  })

  it('有 Validated Plan + Scope Pass 时允许 implement', () => {
    const result = transition(ctx('resolve'), 'implement')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.to).toBe('implement')
  })

  it('resolve 可直接完成非开发输入', () => {
    const result = transition(ctx('resolve'), 'completed')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.to).toBe('completed')
  })

  it('scope_check 上泛用 transition 无 Scope Pass 时不能直接进入 implement', () => {
    const result = transition(
      ctx('scope_check', { hasValidatedPlan: true, hasValidScopePass: false }),
      'implement'
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('illegal_transition')
      expect(result.requestedTo).toBe('implement')
    }
  })
})

describe('nextAfterScopeCheck', () => {
  it('无 HIGH → implement', () => {
    const result = nextAfterScopeCheck(ctx('scope_check'), false)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.to).toBe('implement')
      expect(result.reason).toMatch(/签发 Scope Pass/)
    }
  })

  it('Scope Gate 刚通过时即使事实尚未带 Pass 也可进入 implement', () => {
    const result = nextAfterScopeCheck(
      ctx('scope_check', { hasValidatedPlan: true, hasValidScopePass: false }),
      false
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.to).toBe('implement')
      expect(result.reason).toBe('Scope 通过并签发 Scope Pass 后进入 implement')
    }
  })

  it('有 HIGH 且预算未尽 → plan，并增加 scopeCorrection', () => {
    const result = nextAfterScopeCheck(ctx('scope_check', { scopeCorrectionUsed: 0 }), true)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.to).toBe('plan')
      expect(result.budgetDelta?.scopeCorrection).toBe(1)
    }
  })

  it('Scope 修正预算用尽且仍有 HIGH → waiting_user', () => {
    const result = nextAfterScopeCheck(
      ctx('scope_check', { scopeCorrectionUsed: SCOPE_CORRECTION_BUDGET }),
      true
    )
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.to).toBe('waiting_user')
  })
})

describe('nextAfterTest / nextAfterReview 预算', () => {
  it('测试失败且预算未尽 → fix', () => {
    const result = nextAfterTest(ctx('test', { deliveryTestFixUsed: 0 }), false)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.to).toBe('fix')
      expect(result.budgetDelta?.deliveryTestFix).toBe(1)
    }
  })

  it('Test-Fix 预算耗尽 → waiting_user', () => {
    const result = nextAfterTest(
      ctx('test', { deliveryTestFixUsed: DELIVERY_TEST_FIX_BUDGET }),
      false
    )
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.to).toBe('waiting_user')
  })

  it('测试通过 → review', () => {
    const result = nextAfterTest(ctx('test'), true)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.to).toBe('review')
  })

  it('Review Blocking 且预算未尽 → fix', () => {
    const result = nextAfterReview(ctx('review', { reviewRemediationUsed: 0 }), true)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.to).toBe('fix')
      expect(result.budgetDelta?.reviewRemediation).toBe(1)
    }
  })

  it('Review Remediation 预算耗尽 → waiting_user', () => {
    const result = nextAfterReview(
      ctx('review', { reviewRemediationUsed: REVIEW_REMEDIATION_BUDGET }),
      true
    )
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.to).toBe('waiting_user')
  })

  it('reviewOnly 下即使 Blocking 也 → report，不进 fix', () => {
    const result = nextAfterReview(ctx('review', { reviewOnly: true }), true)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.to).toBe('report')
  })
})

describe('nextAfterFix / report→completed', () => {
  it('fix 扩大范围 → plan；否则 → test', () => {
    const expand = nextAfterFix(ctx('fix'), true)
    expect(expand.ok).toBe(true)
    if (expand.ok) expect(expand.to).toBe('plan')

    const normal = nextAfterFix(ctx('fix'), false)
    expect(normal.ok).toBe(true)
    if (normal.ok) expect(normal.to).toBe('test')
  })

  it('report → completed', () => {
    const result = transition(ctx('report'), 'completed')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.to).toBe('completed')
  })
})

describe('终态冻结', () => {
  it.each(['completed', 'failed', 'cancelled'] as const)(
    '%s 不能被后续事件复活',
    (terminal) => {
      expect(isTerminalStage(terminal)).toBe(true)
      for (const to of ['brainstorm', 'plan', 'implement', 'waiting_user'] as XForgeStage[]) {
        const result = transition(ctx(terminal), to)
        expect(result.ok).toBe(false)
        if (!result.ok) {
          expect(result.code).toBe('terminal_frozen')
          expect(result.reason).toMatch(/终态/)
        }
      }
    }
  )
})
