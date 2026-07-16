import { describe, expect, it } from 'vitest'
import {
  clampStartStage,
  resolveStartStage,
  type StageResolverInput
} from '../../../../../src/runtime/workflow/xforge'

function base(overrides: StageResolverInput = {}): StageResolverInput {
  return { ...overrides }
}

describe('resolveStartStage', () => {
  it('Review Only 优先解析为 review + reviewOnly=true', () => {
    const result = resolveStartStage(
      base({
        reviewOnly: true,
        codeReadyForTest: true,
        hasValidatedPlan: true,
        requestedStartStage: 'implement',
        isBugfix: true
      })
    )
    expect(result.startStage).toBe('review')
    expect(result.reviewOnly).toBe(true)
    expect(result.reason).toMatch(/Review Only/)
  })

  it('代码已改好并请求测试/检查 → test', () => {
    const result = resolveStartStage(base({ codeReadyForTest: true, workspaceDirty: true }))
    expect(result.startStage).toBe('test')
    expect(result.reviewOnly).toBe(false)
  })

  it('明确 bugfix 且未声明已改完 → plan（修复路径）', () => {
    const result = resolveStartStage(base({ isBugfix: true }))
    expect(result.startStage).toBe('plan')
    expect(result.repairPath).toBe(true)
  })

  it('引用设计文档但无 Validated Plan → plan', () => {
    const result = resolveStartStage(base({ hasDesignOnlyDoc: true }))
    expect(result.startStage).toBe('plan')
    expect(result.repairPath).toBeUndefined()
  })

  it('模糊新需求且无 Validated Plan → brainstorm', () => {
    const result = resolveStartStage(base({ isVagueNewRequirement: true }))
    expect(result.startStage).toBe('brainstorm')
  })

  it('有 Validated Plan 但无 Scope Pass → scope_check', () => {
    const result = resolveStartStage(
      base({
        hasValidatedPlan: true,
        planVersion: 1,
        workspaceRevision: 10,
        scopePass: null
      })
    )
    expect(result.startStage).toBe('scope_check')
  })

  it('有 Validated Plan + 当前版本 Scope Pass → implement', () => {
    const result = resolveStartStage(
      base({
        hasValidatedPlan: true,
        planVersion: 2,
        workspaceRevision: 7,
        scopePass: { planVersion: 2, workspaceRevision: 7 }
      })
    )
    expect(result.startStage).toBe('implement')
  })

  it('Scope Pass 版本不匹配时不能 implement，落到 scope_check', () => {
    const result = resolveStartStage(
      base({
        hasValidatedPlan: true,
        planVersion: 3,
        workspaceRevision: 7,
        scopePass: { planVersion: 2, workspaceRevision: 7 }
      })
    )
    expect(result.startStage).toBe('scope_check')
  })

  it('用户指定 implement 但无 Validated Plan 时门禁夹紧到 plan', () => {
    const result = resolveStartStage(
      base({
        requestedStartStage: 'implement',
        hasValidatedPlan: false
      })
    )
    expect(result.startStage).toBe('plan')
    expect(result.reason).toMatch(/门禁夹紧/)
  })

  it('用户指定 implement 有计划无 Scope Pass 时夹紧到 scope_check', () => {
    const result = resolveStartStage(
      base({
        requestedStartStage: 'implement',
        hasValidatedPlan: true,
        planVersion: 1,
        workspaceRevision: 1,
        scopePass: null
      })
    )
    expect(result.startStage).toBe('scope_check')
  })

  it('用户指定 scope_check 但无 Validated Plan 时夹紧到 plan', () => {
    const result = resolveStartStage(
      base({
        requestedStartStage: 'scope_check',
        hasValidatedPlan: false
      })
    )
    expect(result.startStage).toBe('plan')
  })

  it('模型语义分类失败 → 保守 brainstorm，不静默变 default', () => {
    const result = resolveStartStage(base({ modelSemanticHint: 'failed' }))
    expect(result.startStage).toBe('brainstorm')
    expect(result.reason).toMatch(/保守/)
    expect(result.startStage).not.toBe('test')
  })

  it('模型语义分类为 plan 时进入 plan', () => {
    const result = resolveStartStage(
      base({
        modelSemanticHint: 'plan',
        isVagueNewRequirement: false
      })
    )
    expect(result.startStage).toBe('plan')
  })

  it('dirty 工作区本身不能把入口变成 test', () => {
    const result = resolveStartStage(
      base({
        workspaceDirty: true,
        isVagueNewRequirement: true
      })
    )
    expect(result.startStage).toBe('brainstorm')
    expect(result.startStage).not.toBe('test')
  })

  it('dirty + 用户明确已改完 → test', () => {
    const result = resolveStartStage(
      base({
        workspaceDirty: true,
        codeReadyForTest: true
      })
    )
    expect(result.startStage).toBe('test')
  })
})

describe('clampStartStage', () => {
  it('implement 无计划 → plan；无 Pass → scope_check', () => {
    expect(clampStartStage('implement', { hasValidatedPlan: false })).toBe('plan')
    expect(
      clampStartStage('implement', {
        hasValidatedPlan: true,
        planVersion: 1,
        workspaceRevision: 1,
        scopePass: null
      })
    ).toBe('scope_check')
  })
})
