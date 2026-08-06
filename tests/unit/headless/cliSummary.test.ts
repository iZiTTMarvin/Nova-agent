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
  accumulateRepairTotals,
  accumulateRepairOutcomes,
  type HeadlessTurnReport
} from '../../../src/headless/summary'
import type { AgentEvent } from '../../../src/runtime/agent/types'

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

describe('accumulateRepairTotals', () => {
  it('按分型累计计数，非 repair 事件忽略', () => {
    const events: AgentEvent[] = [
      { type: 'message_start', messageId: 'm1' },
      {
        type: 'repair_diagnostic',
        messageId: 'm1',
        kind: 'native_xml',
        toolCallId: 'tc1',
        toolName: 'read'
      },
      {
        type: 'repair_diagnostic',
        messageId: 'm1',
        kind: 'empty_args_from_content',
        toolCallId: 'tc2',
        toolName: 'bash'
      },
      {
        type: 'repair_diagnostic',
        messageId: 'm1',
        kind: 'type_coercion',
        toolCallId: 'tc2',
        toolName: 'bash'
      },
      { type: 'tool_call', messageId: 'm1', toolCallId: 'tc2', toolName: 'bash', args: {} }
    ]

    expect(accumulateRepairTotals(events)).toEqual({
      native_xml: 1,
      empty_args_from_content: 1,
      unclosed_parameter: 0,
      type_coercion: 1,
      tool_name_case: 0
    })
  })

  it('空事件流全零', () => {
    expect(accumulateRepairTotals([])).toEqual({
      native_xml: 0,
      empty_args_from_content: 0,
      unclosed_parameter: 0,
      type_coercion: 0,
      tool_name_case: 0
    })
  })

  it('tool_name_case 分型计数', () => {
    const events: AgentEvent[] = [
      {
        type: 'repair_diagnostic',
        messageId: 'm1',
        kind: 'tool_name_case',
        toolCallId: 'tc1',
        toolName: 'bash'
      }
    ]
    expect(accumulateRepairTotals(events).tool_name_case).toBe(1)
  })
})

describe('accumulateRepairOutcomes', () => {
  it('修复后执行成功的调用计入 success', () => {
    const events: AgentEvent[] = [
      {
        type: 'repair_diagnostic',
        messageId: 'm1',
        kind: 'native_xml',
        toolCallId: 'tc1',
        toolName: 'read'
      },
      {
        type: 'tool_result',
        messageId: 'm1',
        toolCallId: 'tc1',
        toolName: 'read',
        result: 'file content'
      }
    ]
    const outcomes = accumulateRepairOutcomes(events)
    expect(outcomes.native_xml).toEqual({ success: 1, failure: 0 })
  })

  it('修复后执行失败的调用计入 failure（工具执行失败前缀）', () => {
    const events: AgentEvent[] = [
      {
        type: 'repair_diagnostic',
        messageId: 'm1',
        kind: 'empty_args_from_content',
        toolCallId: 'tc2',
        toolName: 'bash'
      },
      {
        type: 'tool_result',
        messageId: 'm1',
        toolCallId: 'tc2',
        toolName: 'bash',
        result: '工具执行失败: command not found'
      }
    ]
    const outcomes = accumulateRepairOutcomes(events)
    expect(outcomes.empty_args_from_content).toEqual({ success: 0, failure: 1 })
  })

  it('同一 toolCallId 的多个分型共享同一执行结果', () => {
    const events: AgentEvent[] = [
      {
        type: 'repair_diagnostic',
        messageId: 'm1',
        kind: 'native_xml',
        toolCallId: 'tc1',
        toolName: 'read'
      },
      {
        type: 'repair_diagnostic',
        messageId: 'm1',
        kind: 'unclosed_parameter',
        toolCallId: 'tc1',
        toolName: 'read'
      },
      {
        type: 'repair_diagnostic',
        messageId: 'm1',
        kind: 'type_coercion',
        toolCallId: 'tc1',
        toolName: 'read'
      },
      {
        type: 'tool_result',
        messageId: 'm1',
        toolCallId: 'tc1',
        toolName: 'read',
        result: 'ok'
      }
    ]
    const outcomes = accumulateRepairOutcomes(events)
    expect(outcomes.native_xml).toEqual({ success: 1, failure: 0 })
    expect(outcomes.unclosed_parameter).toEqual({ success: 1, failure: 0 })
    expect(outcomes.type_coercion).toEqual({ success: 1, failure: 0 })
  })

  it('权限拒绝前缀计入 failure', () => {
    const events: AgentEvent[] = [
      {
        type: 'repair_diagnostic',
        messageId: 'm1',
        kind: 'native_xml',
        toolCallId: 'tc1',
        toolName: 'edit'
      },
      {
        type: 'tool_result',
        messageId: 'm1',
        toolCallId: 'tc1',
        toolName: 'edit',
        result: '权限拒绝: 用户拒绝'
      }
    ]
    const outcomes = accumulateRepairOutcomes(events)
    expect(outcomes.native_xml).toEqual({ success: 0, failure: 1 })
  })

  it('被取消/未执行的修复调用不计入任何结果', () => {
    const events: AgentEvent[] = [
      {
        type: 'repair_diagnostic',
        messageId: 'm1',
        kind: 'native_xml',
        toolCallId: 'tc-no-result',
        toolName: 'read'
      }
    ]
    const outcomes = accumulateRepairOutcomes(events)
    expect(outcomes.native_xml).toEqual({ success: 0, failure: 0 })
  })

  it('空事件流全零', () => {
    const outcomes = accumulateRepairOutcomes([])
    expect(outcomes.native_xml).toEqual({ success: 0, failure: 0 })
    expect(outcomes.empty_args_from_content).toEqual({ success: 0, failure: 0 })
    expect(outcomes.unclosed_parameter).toEqual({ success: 0, failure: 0 })
    expect(outcomes.type_coercion).toEqual({ success: 0, failure: 0 })
    expect(outcomes.tool_name_case).toEqual({ success: 0, failure: 0 })
  })

  it('tool_name_case 修复后执行成功计入 success', () => {
    const events: AgentEvent[] = [
      {
        type: 'repair_diagnostic',
        messageId: 'm1',
        kind: 'tool_name_case',
        toolCallId: 'tc1',
        toolName: 'bash'
      },
      {
        type: 'tool_result',
        messageId: 'm1',
        toolCallId: 'tc1',
        toolName: 'bash',
        result: 'ok'
      }
    ]
    expect(accumulateRepairOutcomes(events).tool_name_case).toEqual({ success: 1, failure: 0 })
  })
})
