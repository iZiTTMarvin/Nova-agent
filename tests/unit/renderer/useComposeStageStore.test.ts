import { beforeEach, describe, expect, it } from 'vitest'
import {
  selectSessionComposePlanApproval,
  selectSessionComposeReviewLoops,
  selectSessionComposeStages,
  useComposeStageStore
} from '../../../src/renderer/features/compose/useComposeStageStore'
import { createInitialStageTable } from '../../../src/shared/composeLifecycle'

describe('useComposeStageStore', () => {
  beforeEach(() => {
    useComposeStageStore.getState().reset()
  })

  it('applyUpdate 按 sessionId 隔离，互不串数据', () => {
    const stagesA = createInitialStageTable()
    const stagesB = createInitialStageTable().map((entry, index) =>
      index === 0 ? { ...entry, status: 'completed' as const, completedAt: 1 } : entry
    )

    useComposeStageStore.getState().applyUpdate({ sessionId: 'sess_a', stages: stagesA })
    useComposeStageStore.getState().applyUpdate({ sessionId: 'sess_b', stages: stagesB })

    const state = useComposeStageStore.getState()
    expect(selectSessionComposeStages(state, 'sess_a')).toEqual(stagesA)
    expect(selectSessionComposeStages(state, 'sess_b')).toEqual(stagesB)
    expect(selectSessionComposeStages(state, 'sess_a')?.[0].status).toBe('in_progress')
    expect(selectSessionComposeStages(state, 'sess_b')?.[0].status).toBe('completed')
  })

  it('未见过的会话 selector 返回 null（投影层回退初始表显示）', () => {
    const state = useComposeStageStore.getState()
    expect(selectSessionComposeStages(state, 'sess_missing')).toBeNull()
    expect(selectSessionComposeStages(state, null)).toBeNull()
  })

  it('setSessionStages 水合持久化阶段表；旧会话无表时写 null', () => {
    const stages = createInitialStageTable()
    useComposeStageStore.getState().setSessionStages('sess_a', stages)
    useComposeStageStore.getState().setSessionStages('sess_legacy', null)

    const state = useComposeStageStore.getState()
    expect(selectSessionComposeStages(state, 'sess_a')).toEqual(stages)
    expect(selectSessionComposeStages(state, 'sess_legacy')).toBeNull()
  })

  it('applyUpdate 覆盖同会话旧表（事件推送是最新事实）', () => {
    const initial = createInitialStageTable()
    const advanced = initial.map((entry, index) =>
      index === 0 ? { ...entry, status: 'completed' as const, completedAt: 1 } : entry
    )

    useComposeStageStore.getState().applyUpdate({ sessionId: 'sess_a', stages: initial })
    useComposeStageStore.getState().applyUpdate({ sessionId: 'sess_a', stages: advanced })

    const state = useComposeStageStore.getState()
    expect(selectSessionComposeStages(state, 'sess_a')?.[0].status).toBe('completed')
  })

  it('reset 清空全部会话缓存', () => {
    useComposeStageStore.getState().applyUpdate({ sessionId: 'sess_a', stages: createInitialStageTable() })
    useComposeStageStore.getState().reset()
    expect(selectSessionComposeStages(useComposeStageStore.getState(), 'sess_a')).toBeNull()
  })

  it('计划确认门：未见过的会话 selector 返回 null', () => {
    const state = useComposeStageStore.getState()
    expect(selectSessionComposePlanApproval(state, 'sess_missing')).toBeNull()
    expect(selectSessionComposePlanApproval(state, null)).toBeNull()
  })

  it('计划确认门：applyPlanApprovalUpdate 按 sessionId 隔离', () => {
    useComposeStageStore.getState().applyPlanApprovalUpdate({
      sessionId: 'sess_a',
      approval: { status: 'approved', approvedAt: 1, auto: false }
    })
    useComposeStageStore.getState().applyPlanApprovalUpdate({
      sessionId: 'sess_b',
      approval: { status: 'pending' }
    })

    const state = useComposeStageStore.getState()
    expect(selectSessionComposePlanApproval(state, 'sess_a')).toEqual({
      status: 'approved',
      approvedAt: 1,
      auto: false
    })
    expect(selectSessionComposePlanApproval(state, 'sess_b')).toEqual({ status: 'pending' })
  })

  it('计划确认门：setSessionPlanApproval 水合持久化状态；旧会话无记录时写 null', () => {
    useComposeStageStore.getState().setSessionPlanApproval('sess_a', { status: 'approved', auto: true })
    useComposeStageStore.getState().setSessionPlanApproval('sess_legacy', null)

    const state = useComposeStageStore.getState()
    expect(selectSessionComposePlanApproval(state, 'sess_a')).toEqual({ status: 'approved', auto: true })
    expect(selectSessionComposePlanApproval(state, 'sess_legacy')).toBeNull()
  })

  it('reset 同时清空计划确认门缓存', () => {
    useComposeStageStore.getState().applyPlanApprovalUpdate({
      sessionId: 'sess_a',
      approval: { status: 'approved' }
    })
    useComposeStageStore.getState().reset()
    expect(selectSessionComposePlanApproval(useComposeStageStore.getState(), 'sess_a')).toBeNull()
  })

  it('applyUpdate 携带的 reviewLoops 按 sessionId 缓存；缺省视为 0', () => {
    useComposeStageStore.getState().applyUpdate({
      sessionId: 'sess_a',
      stages: createInitialStageTable(),
      reviewLoops: 3
    })
    useComposeStageStore.getState().applyUpdate({
      sessionId: 'sess_b',
      stages: createInitialStageTable()
    })

    const state = useComposeStageStore.getState()
    expect(selectSessionComposeReviewLoops(state, 'sess_a')).toBe(3)
    expect(selectSessionComposeReviewLoops(state, 'sess_b')).toBe(0)
    expect(selectSessionComposeReviewLoops(state, null)).toBe(0)
  })

  it('setSessionReviewLoops 水合持久化计数；reset 清空回退到 0', () => {
    useComposeStageStore.getState().setSessionReviewLoops('sess_a', 2)
    expect(selectSessionComposeReviewLoops(useComposeStageStore.getState(), 'sess_a')).toBe(2)

    useComposeStageStore.getState().reset()
    expect(selectSessionComposeReviewLoops(useComposeStageStore.getState(), 'sess_a')).toBe(0)
  })
})
