import {
  COMPOSE_STAGE_IDS,
  isComposeStageId,
  type ComposeStageAction,
  type ComposeStageEntry
} from './types'

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
 */
export function applyStageTransition(
  current: ComposeStageEntry[] | null | undefined,
  action: ComposeStageAction,
  now: number
): { ok: true; stages: ComposeStageEntry[] } | { ok: false; error: string } {
  const stages = current == null ? createInitialStageTable() : cloneStages(current)
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
    return { ok: true, stages }
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
    return { ok: true, stages }
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

  const resetUntil = inProgressIdx >= 0 ? inProgressIdx : stages.length - 1
  for (let i = targetIdx + 1; i <= resetUntil; i++) {
    stages[i] = pendingEntry(stages[i].id)
  }
  stages[targetIdx] = {
    id: stages[targetIdx].id,
    status: 'in_progress',
    note: reason
  }
  return { ok: true, stages }
}
