import { describe, expect, it } from 'vitest'
import {
  COMPOSE_STAGE_IDS,
  applyStageTransition,
  createInitialStageTable,
  getComposeStageCursor,
  isComposeInspectReturnLimited,
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
  it('五阶段固定顺序，问进行中并写入 enteredAt，其余待办', () => {
    const stages = createInitialStageTable(NOW)
    expect(stages.map(s => s.id)).toEqual([...COMPOSE_STAGE_IDS])
    expect(stages[0]).toEqual({ id: 'interview', status: 'in_progress', enteredAt: NOW })
    expect(stages.slice(1).every(s => s.status === 'pending')).toBe(true)
    expect(inProgressCount(stages)).toBe(1)
  })
})

describe('applyStageTransition', () => {
  it.each([1, 3])('不能跳过必须审阅或核验的阶段（游标 %s）', (count) => {
    const stages = completeThrough(createInitialStageTable(NOW), count)
    expect(applyStageTransition(stages, { type: 'skip', reason: '暂时无法验证' }, NOW)).toMatchObject({
      ok: false, error: expect.stringContaining('不能跳过')
    })
  })
  it('complete 顺序推进到下一阶段，并给新进行中阶段写入 enteredAt', () => {
    const result = applyStageTransition(createInitialStageTable(NOW), { type: 'complete' }, NOW)
    expect(result).toEqual({
      ok: true,
      reviewLoops: 0,
      stages: [
        { id: 'interview', status: 'completed', completedAt: NOW },
        { id: 'blueprint', status: 'in_progress', enteredAt: NOW },
        { id: 'build', status: 'pending' },
        { id: 'inspect', status: 'pending' },
        { id: 'deliver', status: 'pending' }
      ]
    })
    if (result.ok) {
      expect(inProgressCount(result.stages)).toBe(1)
      expect(result.stages[0].enteredAt).toBeUndefined()
    }
  })

  it('complete 末阶段进入终态（无进行中）', () => {
    const almostDone = completeThrough(createInitialStageTable(NOW), 4)
    const result = applyStageTransition(almostDone, { type: 'complete' }, NOW + 10)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.stages.every(s => s.status === 'completed')).toBe(true)
    expect(result.stages[4].completedAt).toBe(NOW + 10)
    expect(inProgressCount(result.stages)).toBe(0)
  })

  it('skip 带原因：写入 note/completedAt，下一阶段激活并带 enteredAt', () => {
    const result = applyStageTransition(
      createInitialStageTable(NOW),
      { type: 'skip', reason: '用户已有方案' },
      NOW
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.stages[0]).toEqual({
      id: 'interview',
      status: 'skipped',
      note: '用户已有方案',
      completedAt: NOW
    })
    expect(result.stages[0].enteredAt).toBeUndefined()
    expect(result.stages[1]).toEqual({
      id: 'blueprint',
      status: 'in_progress',
      enteredAt: NOW
    })
    expect(inProgressCount(result.stages)).toBe(1)
  })

  it('skip 无原因拒绝', () => {
    const empty = applyStageTransition(createInitialStageTable(NOW), { type: 'skip', reason: '' }, NOW)
    expect(empty.ok).toBe(false)
    if (empty.ok) return
    expect(empty.error).toMatch(/原因/)

    const blank = applyStageTransition(
      createInitialStageTable(NOW),
      { type: 'skip', reason: '   ' },
      NOW
    )
    expect(blank.ok).toBe(false)
  })

  it('return 重置中间阶段：目标进行中带 note 与 enteredAt，中间清空 note/completedAt', () => {
    const afterBlueprint = completeThrough(createInitialStageTable(NOW), 2)
    const result = applyStageTransition(
      afterBlueprint,
      { type: 'return', targetStage: 'interview', reason: '需求变更' },
      NOW
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.stages[0]).toEqual({
      id: 'interview',
      status: 'in_progress',
      note: '需求变更',
      enteredAt: NOW
    })
    expect(result.stages[1]).toEqual({ id: 'blueprint', status: 'pending' })
    expect(result.stages[2]).toEqual({ id: 'build', status: 'pending' })
    expect(result.stages[1].note).toBeUndefined()
    expect(result.stages[1].completedAt).toBeUndefined()
    expect(result.stages[2].completedAt).toBeUndefined()
    expect(inProgressCount(result.stages)).toBe(1)
  })

  it('return 到当前或更晚阶段拒绝', () => {
    const afterOne = completeThrough(createInitialStageTable(NOW), 1)
    const toCurrent = applyStageTransition(
      afterOne,
      { type: 'return', targetStage: 'blueprint', reason: '不行' },
      NOW
    )
    expect(toCurrent.ok).toBe(false)
    if (!toCurrent.ok) expect(toCurrent.error).toMatch(/回退|更早/)

    const toFuture = applyStageTransition(
      afterOne,
      { type: 'return', targetStage: 'inspect', reason: '越级' },
      NOW
    )
    expect(toFuture.ok).toBe(false)
  })

  it('终态时 complete/skip 拒绝，return 合法并写入 enteredAt', () => {
    const terminal = completeThrough(createInitialStageTable(NOW), 5)
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
      { type: 'return', targetStage: 'build', reason: '返工验证前的实现' },
      NOW
    )
    expect(ret.ok).toBe(true)
    if (!ret.ok) return
    expect(ret.stages[2]).toEqual({
      id: 'build',
      status: 'in_progress',
      note: '返工验证前的实现',
      enteredAt: NOW
    })
    expect(ret.stages.slice(3).every(s => s.status === 'pending')).toBe(true)
    expect(ret.stages[0].status).toBe('completed')
    expect(ret.stages[1].status).toBe('completed')
    expect(inProgressCount(ret.stages)).toBe(1)
  })

  it('非法 targetStage 拒绝', () => {
    const result = applyStageTransition(
      createInitialStageTable(NOW),
      { type: 'return', targetStage: 'not_a_stage' as 'blueprint', reason: '坏目标' },
      NOW
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/目标阶段|无效/)
  })

  it('current 为 null/undefined 时懒创建后应用，第一阶段也会写入 enteredAt', () => {
    const fromNull = applyStageTransition(null, { type: 'complete' }, NOW)
    expect(fromNull.ok).toBe(true)
    if (!fromNull.ok) return
    expect(fromNull.stages[0].status).toBe('completed')
    expect(fromNull.stages[0].enteredAt).toBeUndefined()
    expect(fromNull.stages[1]).toMatchObject({ id: 'blueprint', status: 'in_progress', enteredAt: NOW })

    const fromUndef = applyStageTransition(undefined, { type: 'complete' }, NOW + 1)
    expect(fromUndef.ok).toBe(true)
    if (!fromUndef.ok) return
    expect(fromUndef.stages[0].status).toBe('completed')
    expect(fromUndef.stages[1].enteredAt).toBe(NOW + 1)
  })

  it('成功转换后至多一个 in_progress', () => {
    let stages = createInitialStageTable(NOW)
    const actions = [
      { type: 'complete' as const },
      { type: 'complete' as const },
      { type: 'return' as const, targetStage: 'interview' as const, reason: '重来' },
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

  it('inspect→build 回退第 1–2 次放行且计数递增，第 3 次拒绝', () => {
    const atInspect = completeThrough(createInitialStageTable(NOW), 3)
    let loops: number | undefined
    for (let i = 0; i < 2; i++) {
      const result = applyStageTransition(
        atInspect,
        { type: 'return', targetStage: 'build', reason: `返工 ${i + 1}` },
        NOW,
        loops
      )
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.reviewLoops).toBe(i + 1)
      expect(result.stages[2]).toMatchObject({
        id: 'build',
        status: 'in_progress',
        enteredAt: NOW
      })
      loops = result.reviewLoops
    }

    const third = applyStageTransition(
      atInspect,
      { type: 'return', targetStage: 'build', reason: '第 3 次' },
      NOW,
      loops
    )
    expect(third.ok).toBe(false)
    if (third.ok) return
    expect(third.error).toMatch(/上限/)
    expect(third.error).toContain('停在「验」')
    expect(third.error).toContain('锤')
    expect(isComposeInspectReturnLimited(atInspect, loops)).toBe(true)
  })

  it('未传计数时 inspect 回退按 0 起步', () => {
    const atInspect = completeThrough(createInitialStageTable(NOW), 3)
    const result = applyStageTransition(
      atInspect,
      { type: 'return', targetStage: 'build', reason: '返工' },
      NOW
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.reviewLoops).toBe(1)
    expect(isComposeInspectReturnLimited(atInspect, 0)).toBe(false)
  })

  it('非验阶段发出的回退不计数', () => {
    const atBuild = completeThrough(createInitialStageTable(NOW), 2)
    const fromBuild = applyStageTransition(
      atBuild,
      { type: 'return', targetStage: 'blueprint', reason: '方案要改' },
      NOW,
      2
    )
    expect(fromBuild.ok).toBe(true)
    if (!fromBuild.ok) return
    expect(fromBuild.reviewLoops).toBe(2)

    const atDeliver = completeThrough(createInitialStageTable(NOW), 4)
    const fromDeliver = applyStageTransition(
      atDeliver,
      { type: 'return', targetStage: 'build', reason: '收尾阶段返工' },
      NOW,
      2
    )
    expect(fromDeliver.ok).toBe(true)
    if (!fromDeliver.ok) return
    expect(fromDeliver.reviewLoops).toBe(2)

    const terminal = completeThrough(createInitialStageTable(NOW), 5)
    const fromTerminal = applyStageTransition(
      terminal,
      { type: 'return', targetStage: 'build', reason: '终态返工' },
      NOW,
      2
    )
    expect(fromTerminal.ok).toBe(true)
    if (!fromTerminal.ok) return
    expect(fromTerminal.reviewLoops).toBe(2)
  })

  it('complete / skip 不改变循环计数', () => {
    const atInspect = completeThrough(createInitialStageTable(NOW), 3)
    const complete = applyStageTransition(atInspect, { type: 'complete' }, NOW, 1)
    expect(complete.ok).toBe(true)
    if (!complete.ok) return
    expect(complete.reviewLoops).toBe(1)

    const skip = applyStageTransition(createInitialStageTable(NOW), { type: 'skip', reason: '用户已有需求' }, NOW, 2)
    expect(skip.ok).toBe(true)
    if (!skip.ok) return
    expect(skip.reviewLoops).toBe(2)
  })

  it('验阶段回退到非锤目标同样计数，上限后一并拒绝（防绕过重验）', () => {
    const atInspect = completeThrough(createInitialStageTable(NOW), 3)
    const toBlueprint = applyStageTransition(
      atInspect,
      { type: 'return', targetStage: 'blueprint', reason: '方案本身有误' },
      NOW,
      1
    )
    expect(toBlueprint.ok).toBe(true)
    if (!toBlueprint.ok) return
    expect(toBlueprint.reviewLoops).toBe(2)

    const blocked = applyStageTransition(
      atInspect,
      { type: 'return', targetStage: 'blueprint', reason: '再次回退方案' },
      NOW,
      2
    )
    expect(blocked.ok).toBe(false)
    if (blocked.ok) return
    expect(blocked.error).toMatch(/上限/)
  })
})

describe('getComposeStageCursor', () => {
  it('初始表：当前问、非终态、无可回退阶段', () => {
    const cursor = getComposeStageCursor(createInitialStageTable(NOW))
    expect(cursor).toEqual({ currentStageId: 'interview', isTerminal: false, returnCursor: 0 })
  })

  it('进行中阶段：游标即其下标，之前阶段可回退', () => {
    const stages = completeThrough(createInitialStageTable(NOW), 2)
    const cursor = getComposeStageCursor(stages)
    expect(cursor).toEqual({ currentStageId: 'build', isTerminal: false, returnCursor: 2 })
  })

  it('终态：无当前阶段，游标在末尾之后（全部阶段可回退）', () => {
    const stages = completeThrough(createInitialStageTable(NOW), COMPOSE_STAGE_IDS.length)
    const cursor = getComposeStageCursor(stages)
    expect(cursor).toEqual({
      currentStageId: null,
      isTerminal: true,
      returnCursor: COMPOSE_STAGE_IDS.length
    })
  })

  it('异常表（无进行中且非终态）：不可回退，与转换校验的拒绝口径一致', () => {
    const abnormal: ComposeStageEntry[] = createInitialStageTable(NOW).map(entry => ({
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
