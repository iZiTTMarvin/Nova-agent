/**
 * chat store 内部设施统一出口：纯函数与水合 fence。
 * 不含 zustand，可单独单测；禁止 import slices/ 与组装入口。
 */
export { buildMessageIndex, bumpRevision } from './messageIndex'
export { appendLiveBlock, foldLiveTurnIntoMessages, removeLiveTurnEntry } from './liveTurn'
export { commitMessageList, type CommitMessagesInput } from './commitMessages'
export {
  applyMessageWindowTrim,
  paginationPatchAfterHeadTrim,
  trimMessageWindow
} from './messageWindow'
export {
  getToolCallStatus,
  restoreSessionMessages,
  stripInlinePseudoToolCalls,
  stripLegacyThinkingTags
} from './restoreMessages'
export {
  captureDiffGeneration,
  clearDiffLoadingPatch,
  clearMessageDiffPatch,
  clearRollbackErrorPatch,
  commitLoadedDiffPatch,
  finalDiffPatch,
  initialDiffState,
  invalidateDiffGeneration,
  isDiffGenerationCurrent,
  liveDiffPatch,
  markDiffLoadingPatch,
  resetDiffProjectionForBranchChange,
  setRollbackErrorPatch,
  updateDiffReviewPatch
} from './diffState'
export { omitRecoveryFieldsForMessage } from './recoveryFields'
export {
  invalidateHydrationEpoch,
  isHydrationEpochCurrent,
  nextHydrationEpoch
} from './hydrationEpoch'
export type { ChatStoreApi } from './storeApi'
export { reconcileFocusedSession } from './focusedSessionReconcile'
export { dispatchNextPendingMessage } from './dispatchNextPending'
export { emptyStreamTransientState } from './streamTransients'
