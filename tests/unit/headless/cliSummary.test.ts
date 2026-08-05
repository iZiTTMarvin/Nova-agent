/**
 * headless summary 派生口径单测（终态诚实的 CLI 层护栏）。
 *
 * 锁定预算判定 / failure_class / 退出码三者的唯一口径：
 * - max_rounds 截断 → budget_exhausted=true、failure_class=max_rounds、退出码非零
 * - breaker / empty_args → budget_exhausted=false、failure_class 取截断原因、退出码非零
 * - deadline 到期取消 → budget_exhausted=true、failure_class=budget_exhausted、退出码为零（沿用既有语义）
 * - completed → 无 failure_class、退出码为零
 */
import { describe, it, expect } from 'vitest'
import {
  deriveHeadlessSummary,
  type HeadlessTurnReport
} from '../../../src/headless/summary'

function report(
  status: HeadlessTurnReport['status'],
  deadlineReached = false,
  reason?: Extract<HeadlessTurnReport, { status: 'incomplete' }>['reason']
): HeadlessTurnReport {
  if (status === 'incomplete' && reason) {
    return { status, reason, deadlineReached }
  }
  return { status, deadlineReached }
}

describe('deriveHeadlessSummary', () => {
  it('max_rounds 截断 → budget_exhausted=true，failure_class=max_rounds，退出码非零', () => {
    const derived = deriveHeadlessSummary(report('incomplete', false, 'max_rounds'))

    expect(derived.budgetExhausted).toBe(true)
    expect(derived.failureClass).toBe('max_rounds')
    expect(derived.exitNonZero).toBe(true)
  })

  it('breaker 截断 → budget_exhausted=false，failure_class=breaker，退出码非零', () => {
    const derived = deriveHeadlessSummary(report('incomplete', false, 'breaker'))

    expect(derived.budgetExhausted).toBe(false)
    expect(derived.failureClass).toBe('breaker')
    expect(derived.exitNonZero).toBe(true)
  })

  it('empty_args 截断 → budget_exhausted=false，failure_class=empty_args，退出码非零', () => {
    const derived = deriveHeadlessSummary(report('incomplete', false, 'empty_args'))

    expect(derived.budgetExhausted).toBe(false)
    expect(derived.failureClass).toBe('empty_args')
    expect(derived.exitNonZero).toBe(true)
  })

  it('completed → 无 failure_class，退出码为零', () => {
    const derived = deriveHeadlessSummary(report('completed'))

    expect(derived.budgetExhausted).toBe(false)
    expect(derived.failureClass).toBeNull()
    expect(derived.exitNonZero).toBe(false)
  })

  it('普通取消 → failure_class=agent_cancelled，退出码非零', () => {
    const derived = deriveHeadlessSummary(report('cancelled'))

    expect(derived.budgetExhausted).toBe(false)
    expect(derived.failureClass).toBe('agent_cancelled')
    expect(derived.exitNonZero).toBe(true)
  })

  it('deadline 到期取消 → budget_exhausted=true，failure_class=budget_exhausted，退出码为零', () => {
    const derived = deriveHeadlessSummary(report('cancelled', true))

    expect(derived.budgetExhausted).toBe(true)
    expect(derived.failureClass).toBe('budget_exhausted')
    expect(derived.exitNonZero).toBe(false)
  })

  it('failed → failure_class=agent_error，退出码非零', () => {
    const derived = deriveHeadlessSummary(report('failed'))

    expect(derived.budgetExhausted).toBe(false)
    expect(derived.failureClass).toBe('agent_error')
    expect(derived.exitNonZero).toBe(true)
  })
})
