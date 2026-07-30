import type { DiffEntry, DiffReviewStatus } from '../../../../shared/diff/types'
import type { ChatState, DiffSliceState, MessageDiffCache } from '../types'

type DiffStateFields = Pick<
  DiffSliceState,
  'messageDiffs' | 'loadingDiffs' | 'loadingDiffPlaceholders' | 'rollbackErrors'
>

let diffGeneration = 0

export function initialDiffState(): DiffStateFields {
  return {
    messageDiffs: {},
    loadingDiffs: new Set(),
    loadingDiffPlaceholders: {},
    rollbackErrors: {}
  }
}

/** 会话或消息序列变化后，旧异步 diff 结果不得再写回当前投影。 */
export function invalidateDiffGeneration(): void {
  diffGeneration += 1
}

export function captureDiffGeneration(): number {
  return diffGeneration
}

export function isDiffGenerationCurrent(generation: number): boolean {
  return generation === diffGeneration
}

/** 分叉后磁盘基线已变化，只清除 diff 投影；回滚错误仍由对应操作维护。 */
function clearDiffProjectionPatch(): Pick<
  DiffStateFields,
  'messageDiffs' | 'loadingDiffs' | 'loadingDiffPlaceholders'
> {
  return {
    messageDiffs: {},
    loadingDiffs: new Set(),
    loadingDiffPlaceholders: {}
  }
}

/** active path 已改变时，同时让此前已发出的 diff IPC 结果失效。 */
export function resetDiffProjectionForBranchChange(): Pick<
  DiffStateFields,
  'messageDiffs' | 'loadingDiffs' | 'loadingDiffPlaceholders'
> {
  invalidateDiffGeneration()
  return clearDiffProjectionPatch()
}

/** 把单条 diff 文件标记为某个 review 状态（若该文件尚未进入 diffs 列表则先追加占位）。 */
function applyDiffReviewStatus(
  cache: MessageDiffCache,
  filePath: string,
  status: DiffReviewStatus
): MessageDiffCache {
  const existingDiff = cache.diffs.find(diff => diff.filePath === filePath)
  const nextDiffs = existingDiff
    ? cache.diffs
    : [...cache.diffs, { filePath, hunks: [], status: 'modified' as const }]

  return {
    diffs: nextDiffs,
    reviews: { ...cache.reviews, [filePath]: status }
  }
}

export function markDiffLoadingPatch(
  state: DiffStateFields,
  messageId: string
): Pick<DiffStateFields, 'loadingDiffs'> {
  return { loadingDiffs: new Set([...state.loadingDiffs, messageId]) }
}

export function clearDiffLoadingPatch(
  state: DiffStateFields,
  messageId: string
): Pick<DiffStateFields, 'loadingDiffs'> {
  const loadingDiffs = new Set(state.loadingDiffs)
  loadingDiffs.delete(messageId)
  return { loadingDiffs }
}

export function commitLoadedDiffPatch(
  state: DiffStateFields,
  messageId: string,
  cache: MessageDiffCache
): Pick<DiffStateFields, 'messageDiffs' | 'loadingDiffs' | 'loadingDiffPlaceholders'> {
  const loadingDiffs = new Set(state.loadingDiffs)
  loadingDiffs.delete(messageId)
  const { [messageId]: _drop, ...loadingDiffPlaceholders } = state.loadingDiffPlaceholders
  return {
    messageDiffs: { ...state.messageDiffs, [messageId]: cache },
    loadingDiffs,
    loadingDiffPlaceholders
  }
}

export function updateDiffReviewPatch(
  state: DiffStateFields,
  messageId: string,
  filePaths: string[],
  status: DiffReviewStatus
): Pick<DiffStateFields, 'messageDiffs'> {
  const cache = state.messageDiffs[messageId]
  if (!cache) return { messageDiffs: state.messageDiffs }

  let updated = cache
  for (const filePath of filePaths) {
    updated = applyDiffReviewStatus(updated, filePath, status)
  }
  return { messageDiffs: { ...state.messageDiffs, [messageId]: updated } }
}

export function clearMessageDiffPatch(
  state: DiffStateFields,
  messageId: string
): Pick<DiffStateFields, 'messageDiffs'> {
  const { [messageId]: _drop, ...messageDiffs } = state.messageDiffs
  return { messageDiffs }
}

export function liveDiffPatch(
  state: DiffStateFields,
  messageId: string,
  diffs: Array<{ filePath: string; status: DiffEntry['status'] }>
): Pick<DiffStateFields, 'loadingDiffs' | 'loadingDiffPlaceholders'> {
  return {
    loadingDiffs: new Set([...state.loadingDiffs, messageId]),
    loadingDiffPlaceholders: {
      ...state.loadingDiffPlaceholders,
      [messageId]: diffs.map(diff => ({ filePath: diff.filePath, status: diff.status }))
    }
  }
}

export function finalDiffPatch(
  state: DiffStateFields,
  messageId: string,
  diffs: DiffEntry[],
  reviews: Record<string, DiffReviewStatus>
): Pick<DiffStateFields, 'messageDiffs' | 'loadingDiffs' | 'loadingDiffPlaceholders'> {
  return commitLoadedDiffPatch(state, messageId, { diffs, reviews })
}

export function setRollbackErrorPatch(
  state: Pick<ChatState, 'rollbackErrors'>,
  messageId: string,
  error: string
): Pick<DiffStateFields, 'rollbackErrors'> {
  return { rollbackErrors: { ...state.rollbackErrors, [messageId]: error } }
}

export function clearRollbackErrorPatch(
  state: Pick<ChatState, 'rollbackErrors'>,
  messageId: string
): Pick<DiffStateFields, 'rollbackErrors'> {
  const { [messageId]: _drop, ...rollbackErrors } = state.rollbackErrors
  return { rollbackErrors }
}
