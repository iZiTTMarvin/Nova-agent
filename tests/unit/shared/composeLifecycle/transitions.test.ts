import { describe, expect, it } from 'vitest'
import {
  COMPOSE_STAGE_IDS,
  applyStageTransition,
  createInitialStageTable,
  getComposeStageCursor,
  type ComposeStageEntry
} from '../../../../src/shared/composeLifecycle'

const NOW = 1_700_000_000_000

function inProgressCount(stages: ComposeStageEntry[]): number {
  return stages.filter(s => s.status === 'in_progress').length
}

function completeThrough(stages: ComposeStageEntry[], count: number): ComposeStageEntry[] {
  let current = stages
  for (let i = 0; i < count; i++) {
    const result = applyStageTransition(current, { type: 'complete' }, NOW + i)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.error)
    current = result.stages
  }
  return current
}

describe('createInitialStageTable', () => {
  it('六阶段固定顺序，构思进行中，其余待办', () => {
    const stages = createInitialStageTable()
    expect(stages.map(s => s.id)).toEqual([...COMPOSE_STAGE_IDS])
    expect(stages[0]).toMatchObject({ id: 'brainstorm', status: 'in_progress' })
    expect(stages.slice(1).every(s => s.status === 'pending')).toBe(true)
    expect(inProgressCount(stages)).toBe(1)
  })
})

describe('applyStageTransition', () => {
  it('complete 顺序推进到下一阶段', () => {
    const result = applyStageTransition(createInitialStageTable(), { type: 'complete' }, NOW)
    expect(result).toEqual({
      ok: true,
      stages: [
        { id: 'brainstorm', status: 'completed', completedAt: NOW },
        { id: 'plan', status: 'in_progress' },
        { id: 'implement', status: 'pending' },
        { id: 'verify', status: 'pending' },
        { id: 'review', status: 'pending' },
        { id: 'report', status: 'pending' }
      ]
    })
    if (result.ok) expect(inProgressCount(result.stages)).toBe(1)
  })

  it('complete 末阶段进入终态（无进行中）', () => {
    const almostDone = completeThrough(createInitialStageTable(), 5)
    const result = applyStageTransition(almostDone, { type: 'complete' }, NOW + 10)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.stages.every(s => s.status === 'completed')).toBe(true)
    expect(result.stages[5].completedAt).toBe(NOW + 10)
    expect(inProgressCount(result.stages)).toBe(0)
  })

  it('skip 带原因：写入 note/completedAt，下一阶段激活', () => {
    const result = applyStageTransition(
      createInitialStageTable(),
      { type: 'skip', reason: '用户已有方案' },
      NOW
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.stages[0]).toEqual({
      id: 'brainstorm',
      status: 'skipped',
      note: '用户已有方案',
      completedAt: NOW
    })
    expect(result.stages[1].status).toBe('in_progress')
    expect(inProgressCount(result.stages)).toBe(1)
  })

  it('skip 无原因拒绝', () => {
    const empty = applyStageTransition(createInitialStageTable(), { type: 'skip', reason: '' }, NOW)
    expect(empty.ok).toBe(false)
    if (empty.ok) return
    expect(empty.error).toMatch(/原因/)

    const blank = applyStageTransition(
      createInitialStageTable(),
      { type: 'skip', reason: '   ' },
      NOW
    )
    expect(blank.ok).toBe(false)
  })

  it('return 重置中间阶段：目标进行中带 note，中间清空 note/completedAt', () => {
    const afterPlan = completeThrough(createInitialStageTable(), 2)
    // brainstorm+plan completed, implement in_progress
    const result = applyStageTransition(
      afterPlan,
      { type: 'return', targetStage: 'brainstorm', reason: '需求变更' },
      NOW
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.stages[0]).toEqual({
      id: 'brainstorm',
      status: 'in_progress',
      note: '需求变更'
    })
    expect(result.stages[1]).toEqual({ id: 'plan', status: 'pending' })
    expect(result.stages[2]).toEqual({ id: 'implement', status: 'pending' })
    expect(result.stages[1].note).toBeUndefined()
    expect(result.stages[1].completedAt).toBeUndefined()
    expect(result.stages[2].completedAt).toBeUndefined()
    expect(inProgressCount(result.stages)).toBe(1)
  })

  it('return 到当前或更晚阶段拒绝', () => {
    const afterOne = completeThrough(createInitialStageTable(), 1)
    const toCurrent = applyStageTransition(
      afterOne,
      { type: 'return', targetStage: 'plan', reason: '不行' },
      NOW
    )
    expect(toCurrent.ok).toBe(false)
    if (!toCurrent.ok) expect(toCurrent.error).toMatch(/回退|更早/)

    const toFuture = applyStageTransition(
      afterOne,
      { type: 'return', targetStage: 'review', reason: '越级' },
      NOW
    )
    expect(toFuture.ok).toBe(false)
  })

  it('终态时 complete/skip 拒绝，return 合法', () => {
    const terminal = completeThrough(createInitialStageTable(), 6)
    expect(inProgressCount(terminal)).toBe(0)

    const complete = applyStageTransition(terminal, { type: 'complete' }, NOW)
    expect(complete.ok).toBe(false)

    const skip = applyStageTransition(
      terminal,
      { type: 'skip', reason: '多余' },
      NOW
    )
    expect(skip.ok).toBe(false)

    const ret = applyStageTransition(
      terminal,
      { type: 'return', targetStage: 'implement', reason: '返工验证前的实现' },
      NOW
    )
    expect(ret.ok).toBe(true)
    if (!ret.ok) return
    expect(ret.stages[2]).toMatchObject({
      id: 'implement',
      status: 'in_progress',
      note: '返工验证前的实现'
    })
    expect(ret.stages.slice(3).every(s => s.status === 'pending')).toBe(true)
    expect(ret.stages[0].status).toBe('completed')
    expect(ret.stages[1].status).toBe('completed')
    expect(inProgressCount(ret.stages)).toBe(1)
  })

  it('非法 targetStage 拒绝', () => {
    const result = applyStageTransition(
      createInitialStageTable(),
      { type: 'return', targetStage: 'not_a_stage' as 'plan', reason: '坏目标' },
      NOW
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/目标阶段|无效/)
  })

  it('current 为 null/undefined 时懒创建后应用', () => {
    const fromNull = applyStageTransition(null, { type: 'complete' }, NOW)
    expect(fromNull.ok).toBe(true)
    if (!fromNull.ok) return
    expect(fromNull.stages[0].status).toBe('completed')
    expect(fromNull.stages[1].status).toBe('in_progress')

    const fromUndef = applyStageTransition(undefined, { type: 'complete' }, NOW + 1)
    expect(fromUndef.ok).toBe(true)
    if (!fromUndef.ok) return
    expect(fromUndef.stages[0].status).toBe('completed')
  })

  it('成功转换后至多一个 in_progress', () => {
    let stages = createInitialStageTable()
    const actions = [
      { type: 'complete' as const },
      { type: 'skip' as const, reason: '跳过计划' },
      { type: 'return' as const, targetStage: 'brainstorm' as const, reason: '重来' },
      { type: 'complete' as const },
      { type: 'complete' as const }
    ]
    for (const action of actions) {
      const result = applyStageTransition(stages, action, NOW)
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(inProgressCount(result.stages)).toBeLessThanOrEqual(1)
      stages = result.stages
    }
  })
})

describe('getComposeStageCursor', () => {
  it('初始表：当前构思、非终态、无可回退阶段', () => {
    const cursor = getComposeStageCursor(createInitialStageTable())
    expect(cursor).toEqual({ currentStageId: 'brainstorm', isTerminal: false, returnCursor: 0 })
  })

  it('进行中阶段：游标即其下标，之前阶段可回退', () => {
    const stages = completeThrough(createInitialStageTable(), 2)
    const cursor = getComposeStageCursor(stages)
    expect(cursor).toEqual({ currentStageId: 'implement', isTerminal: false, returnCursor: 2 })
  })

  it('终态：无当前阶段，游标在末尾之后（全部阶段可回退）', () => {
    const stages = completeThrough(createInitialStageTable(), COMPOSE_STAGE_IDS.length)
    const cursor = getComposeStageCursor(stages)
    expect(cursor).toEqual({
      currentStageId: null,
      isTerminal: true,
      returnCursor: COMPOSE_STAGE_IDS.length
    })
  })

  it('异常表（无进行中且非终态）：不可回退，与转换校验的拒绝口径一致', () => {
    const abnormal: ComposeStageEntry[] = createInitialStageTable().map(entry => ({
      id: entry.id,
      status: 'pending'
    }))
    const cursor = getComposeStageCursor(abnormal)
    expect(cursor).toEqual({ currentStageId: null, isTerminal: false, returnCursor: 0 })
  })

  it('空表：非终态、不可回退', () => {
    expect(getComposeStageCursor([])).toEqual({
      currentStageId: null,
      isTerminal: false,
      returnCursor: 0
    })
  })
})
