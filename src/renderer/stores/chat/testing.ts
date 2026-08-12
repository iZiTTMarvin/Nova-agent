import { invalidateDiffGeneration, invalidateHydrationEpoch } from './internal'
import type { ChatStoreApi } from './internal'
import {
  initialBranchState,
  initialDiffState,
  initialLiveTurnState,
  initialMessageState,
  initialPaginationState,
  invalidatePaginationGeneration,
  initialRecoveryState,
  initialSendState,
  initialSessionState,
  initialStreamState,
  initialTurnLifecycleState,
  initialWorkspaceSyncState
} from './slices'

/** 测试重置从各 owner 的 initial state 派生，避免复制生产默认值。 */
export function resetChatStoreStateForTests(store: ChatStoreApi): void {
  invalidateHydrationEpoch()
  invalidateDiffGeneration()
  invalidatePaginationGeneration()
  store.setState({
    ...initialSessionState(),
    ...initialMessageState(),
    ...initialLiveTurnState(),
    ...initialWorkspaceSyncState(),
    ...initialBranchState(),
    ...initialTurnLifecycleState(),
    ...initialSendState(),
    ...initialStreamState(),
    ...initialDiffState(),
    ...initialRecoveryState(),
    ...initialPaginationState()
  })
}
