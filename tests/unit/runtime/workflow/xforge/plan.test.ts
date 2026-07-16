import { describe, expect, it } from 'vitest'
import {
  createTaskStatesFromPlan,
  validateXForgePlan,
  type XForgeValidatedPlan
} from '../../../../../src/runtime/workflow/xforge'

function validPlan(overrides: Partial<XForgeValidatedPlan> = {}): XForgeValidatedPlan {
  return {
    version: 1,
    goal: '实现 XForge M2',
    constraints: ['不自动 commit'],
    nonGoals: ['不做 M3 review'],
    repositoryFacts: ['已有 RunCoordinator'],
    changeScope: ['runtime/workflow/xforge'],
    tasks: [{ id: 't1', title: '任务循环', acceptance: ['三次失败可跳过'] }],
    acceptanceMap: { t1: ['三次失败可跳过'] },
    verificationChecklist: ['vitest'],
    risks: ['权限边界误放宽'],
    ...overrides
  }
}

describe('Validated Plan 判定', () => {
  it('完整计划通过校验，并可投影成任务状态', () => {
    const plan = validPlan()
    expect(validateXForgePlan(plan)).toEqual({ valid: true, missing: [] })

    const tasks = createTaskStatesFromPlan(plan)
    expect(tasks).toEqual([
      {
        id: 't1',
        title: '任务循环',
        status: 'pending',
        acceptance: ['三次失败可跳过'],
        attempts: 0,
        evidenceRefs: []
      }
    ])
  })

  it('缺少任务验收映射时不能冒充 Validated Plan', () => {
    const result = validateXForgePlan(validPlan({ acceptanceMap: {} }))
    expect(result.valid).toBe(false)
    expect(result.missing).toContain('acceptanceMap.t1')
  })

  it('没有字面验证命令的计划仍可导入，交付 Test Gate 负责后续安全阻断', () => {
    expect(validateXForgePlan(validPlan({ verificationChecklist: [] }))).toEqual({ valid: true, missing: [] })
  })

  it('设计-only 文档字段不足时会列出缺口', () => {
    const result = validateXForgePlan({
      version: 1,
      goal: '只有设计想法'
    })
    expect(result.valid).toBe(false)
    expect(result.missing).toEqual(
      expect.arrayContaining(['constraints', 'tasks', 'verificationChecklist', 'risks'])
    )
  })
})
