import {
  COMPOSE_STAGE_IDS,
  isComposeStageId,
  type ComposeStageAction,
  type ComposeStageEntry,
  type ComposeStageId
} from './types'

export interface ComposeStageCursor {
  /** 当前进行中阶段；终态或异常表为 null */
  currentStageId: ComposeStageId | null
  /** 无进行中且全部 completed/skipped：生命周期已走完 */
  isTerminal: boolean
  /**
   * 回退游标：仅下标小于 returnCursor 的阶段可作为回退目标。
   * 口径与 applyStageTransition 一致：进行中阶段的下标；终态视作游标在
   * 末尾之后（任意阶段可回退）；异常表（无进行中且非终态）为 0（不可回退）。
   */
  returnCursor: number
}

/**
 * 阶段表读路径游标：门禁、UI 投影等消费方共用同一份推导，
 * 避免各处重复实现「当前阶段 / 终态 / 可回退范围」导致口径漂移。
 */
export function getComposeStageCursor(
  stages: ReadonlyArray<Pick<ComposeStageEntry, 'id' | 'status'>>
): ComposeStageCursor {
  const inProgressIdx = stages.findIndex(entry => entry.status === 'in_progress')
  const isTerminal =
    inProgressIdx < 0 &&
    stages.length > 0 &&
    stages.every(entry => entry.status === 'completed' || entry.status === 'skipped')
  return {
    currentStageId: inProgressIdx >= 0 ? stages[inProgressIdx].id : null,
    isTerminal,
    returnCursor: inProgressIdx >= 0 ? inProgressIdx : isTerminal ? stages.length : 0
  }
}

export function createInitialStageTable(): ComposeStageEntry[] {
  return COMPOSE_STAGE_IDS.map((id, index) => ({
    id,
    status: index === 0 ? 'in_progress' : 'pending'
  }))
}

function cloneStages(stages: ComposeStageEntry[]): ComposeStageEntry[] {
  return stages.map(entry => ({ ...entry }))
}

function findInProgressIndex(stages: ComposeStageEntry[]): number {
  return stages.findIndex(entry => entry.status === 'in_progress')
}

function isTerminal(stages: ComposeStageEntry[]): boolean {
  return (
    findInProgressIndex(stages) < 0 &&
    stages.every(entry => entry.status === 'completed' || entry.status === 'skipped')
  )
}

function pendingEntry(id: ComposeStageEntry['id']): ComposeStageEntry {
  return { id, status: 'pending' }
}

/**
 * 对阶段表应用一次转换。current 为空时先物化初始表（懒创建）。
 * 非法转换返回中文可读原因，不抛异常。
 *
 * reviewLoops 为修复-复审循环计数；审查阶段发出的回退放行时 +1，
 * 其余转换原样返回，超 3 次拒绝（代码兜底，与阶段指南口径一致）。
 */
export function applyStageTransition(
  current: ComposeStageEntry[] | null | undefined,
  action: ComposeStageAction,
  now: number,
  reviewLoops?: number
): { ok: true; stages: ComposeStageEntry[]; reviewLoops: number } | { ok: false; error: string } {
  const stages = current == null ? createInitialStageTable() : cloneStages(current)
  const loops = reviewLoops ?? 0
  const inProgressCount = stages.filter(entry => entry.status === 'in_progress').length
  if (inProgressCount > 1) {
    return { ok: false, error: '阶段表状态异常：存在多个进行中的阶段' }
  }

  const inProgressIdx = findInProgressIndex(stages)
  const terminal = isTerminal(stages)
  if (inProgressIdx < 0 && !terminal) {
    return { ok: false, error: '阶段表状态异常：缺少进行中的阶段' }
  }

  if (action.type === 'complete') {
    if (inProgressIdx < 0) {
      return { ok: false, error: '生命周期已结束，无法再完成阶段' }
    }
    const currentId = stages[inProgressIdx].id
    stages[inProgressIdx] = {
      id: currentId,
      status: 'completed',
      completedAt: now
    }
    if (inProgressIdx + 1 < stages.length) {
      stages[inProgressIdx + 1] = {
        id: stages[inProgressIdx + 1].id,
        status: 'in_progress'
      }
    }
    return { ok: true, stages, reviewLoops: loops }
  }

  if (action.type === 'skip') {
    const reason = action.reason.trim()
    if (!reason) {
      return { ok: false, error: '跳过阶段必须提供原因' }
    }
    if (inProgressIdx < 0) {
      return { ok: false, error: '生命周期已结束，无法再跳过阶段' }
    }
    const currentId = stages[inProgressIdx].id
    stages[inProgressIdx] = {
      id: currentId,
      status: 'skipped',
      note: reason,
      completedAt: now
    }
    if (inProgressIdx + 1 < stages.length) {
      stages[inProgressIdx + 1] = {
        id: stages[inProgressIdx + 1].id,
        status: 'in_progress'
      }
    }
    return { ok: true, stages, reviewLoops: loops }
  }

  // return
  const reason = action.reason.trim()
  if (!reason) {
    return { ok: false, error: '回退阶段必须提供原因' }
  }
  if (!isComposeStageId(action.targetStage)) {
    return { ok: false, error: '无效的目标阶段' }
  }
  const targetIdx = COMPOSE_STAGE_IDS.indexOf(action.targetStage)
  // 终态视作游标在末尾之后，任意已完成阶段均可回退
  const cursorIdx = inProgressIdx >= 0 ? inProgressIdx : stages.length
  if (targetIdx >= cursorIdx) {
    return { ok: false, error: '只能回退到当前进行中阶段之前的阶段' }
  }

  // 审查阶段发出的任何回退都计为一次修复-复审返工（不限于回退开发，
  // 否则经回退计划等路径可绕开上限无限重审）：3 次后拒绝并让主 Agent 停住向用户说明
  const isReviewReturn = inProgressIdx >= 0 && stages[inProgressIdx].id === 'review'
  if (isReviewReturn && loops >= 3) {
    return {
      ok: false,
      error: '修复-复审循环已达上限（3 次）。请向用户说明审查结论与阻塞点，停在审查阶段等待用户决定。'
    }
  }

  const resetUntil = inProgressIdx >= 0 ? inProgressIdx : stages.length - 1
  for (let i = targetIdx + 1; i <= resetUntil; i++) {
    stages[i] = pendingEntry(stages[i].id)
  }
  stages[targetIdx] = {
    id: stages[targetIdx].id,
    status: 'in_progress',
    note: reason
  }
  return { ok: true, stages, reviewLoops: isReviewReturn ? loops + 1 : loops }
}
