import { beforeEach, describe, expect, it } from 'vitest'
import {
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
})
