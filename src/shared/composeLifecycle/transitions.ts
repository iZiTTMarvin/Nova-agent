import {
  COMPOSE_STAGE_IDS,
  COMPOSE_STAGE_LABELS,
  isComposeStageId,
  type ComposeStageAction,
  type ComposeStageEntry,
  type ComposeStageId
} from './types'

/** 从「验」回退的次数上限（与阶段指南口径一致，applyStageTransition 兜底拒绝） */
export const COMPOSE_MAX_INSPECT_LOOPS = 2

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

export function createInitialStageTable(now = Date.now()): ComposeStageEntry[] {
  return COMPOSE_STAGE_IDS.map((id, index) =>
    index === 0
      ? { id, status: 'in_progress' as const, enteredAt: now }
      : { id, status: 'pending' as const }
  )
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

function inProgressEntry(
  id: ComposeStageId,
  now: number,
  extra?: { note?: string }
): ComposeStageEntry {
  const entry: ComposeStageEntry = { id, status: 'in_progress', enteredAt: now }
  if (extra?.note !== undefined) entry.note = extra.note
  return entry
}

/**
 * 对阶段表应用一次转换。current 为空时先物化初始表（懒创建）。
 * 非法转换返回中文可读原因，不抛异常。
 *
 * reviewLoops 为从「验」回退的循环计数；验阶段发出的回退放行时 +1，
 * 其余转换原样返回，超上限拒绝（代码兜底，与阶段指南口径一致）。
 */
export function applyStageTransition(
  current: ComposeStageEntry[] | null | undefined,
  action: ComposeStageAction,
  now: number,
  reviewLoops?: number
): { ok: true; stages: ComposeStageEntry[]; reviewLoops: number } | { ok: false; error: string } {
  const stages = current == null ? createInitialStageTable(now) : cloneStages(current)
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
      stages[inProgressIdx + 1] = inProgressEntry(stages[inProgressIdx + 1].id, now)
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
    if (currentId === 'blueprint' || currentId === 'inspect') {
      return { ok: false, error: `「${COMPOSE_STAGE_LABELS[currentId]}」不能跳过；请完成审阅或核验后使用 complete，受阻时停在当前阶段说明原因。` }
    }
    stages[inProgressIdx] = {
      id: currentId,
      status: 'skipped',
      note: reason,
      completedAt: now
    }
    if (inProgressIdx + 1 < stages.length) {
      stages[inProgressIdx + 1] = inProgressEntry(stages[inProgressIdx + 1].id, now)
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

  // 「验」发出的任何回退都计为一次返工（不限于回退「锤」，
  // 否则经回退「图」等路径可绕开上限无限重验）：超上限拒绝并让主 Agent 停住向用户说明
  const isInspectReturn = inProgressIdx >= 0 && stages[inProgressIdx].id === 'inspect'
  if (isInspectReturn && loops >= COMPOSE_MAX_INSPECT_LOOPS) {
    return {
      ok: false,
      error: `从「验」回退已达上限（${COMPOSE_MAX_INSPECT_LOOPS} 次）。请向用户说明核验结论与阻塞点，停在「验」等待用户决定，不要再回退到「锤」。`
    }
  }

  const resetUntil = inProgressIdx >= 0 ? inProgressIdx : stages.length - 1
  for (let i = targetIdx + 1; i <= resetUntil; i++) {
    stages[i] = pendingEntry(stages[i].id)
  }
  stages[targetIdx] = inProgressEntry(stages[targetIdx].id, now, { note: reason })
  return { ok: true, stages, reviewLoops: isInspectReturn ? loops + 1 : loops }
}

/**
 * 「验」发起的回退是否已达循环上限（仅当前阶段为 inspect 时可能受限）。
 * 与 applyStageTransition 的兜底拒绝口径共用同一常量，UI 据此预禁用回退入口。
 */
export function isComposeInspectReturnLimited(
  stages: ReadonlyArray<Pick<ComposeStageEntry, 'id' | 'status'>>,
  reviewLoops?: number
): boolean {
  const inProgressIdx = stages.findIndex(entry => entry.status === 'in_progress')
  const isInspectReturn = inProgressIdx >= 0 && stages[inProgressIdx].id === 'inspect'
  return isInspectReturn && (reviewLoops ?? 0) >= COMPOSE_MAX_INSPECT_LOOPS
}
