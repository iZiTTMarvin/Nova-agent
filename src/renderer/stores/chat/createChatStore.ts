import { create } from 'zustand'
import type { ChatState } from './types'
import {
  createBranchSlice,
  createDiffSlice,
  createMessageSlice,
  createPaginationSlice,
  createRecoverySlice,
  createSendSlice,
  createSessionSlice,
  createStreamSlice,
  createTurnLifecycleSlice,
  createWorkspaceSyncSlice,
  invalidatePaginationGeneration,
  initialDiffState,
  initialPaginationState,
  resetBranchForkOnSessionSwitch,
  resetMessageOnSessionSwitch,
  resetSendOnSessionSwitch,
  resetStreamOnSessionSwitch,
  resetTurnLifecycleOnSessionSwitch
} from './slices'

/** 唯一的 create<ChatState> 调用点，负责装配 slice 与跨 owner reset 端口。 */
export function createChatStore() {
  const createWorkspaceSync = createWorkspaceSyncSlice({
    buildSessionChangePatch: () => ({
      ...resetMessageOnSessionSwitch(),
      ...resetTurnLifecycleOnSessionSwitch(),
      ...resetSendOnSessionSwitch(),
      ...resetBranchForkOnSessionSwitch(),
      ...resetStreamOnSessionSwitch()
    }),
    buildMessageSequenceResetPatch: () => {
      invalidatePaginationGeneration()
      return {
        ...initialDiffState(),
        ...initialPaginationState()
      }
    }
  })

  return create<ChatState>((set, get, api) => ({
    ...createMessageSlice(set, get, api),
    ...createStreamSlice(set, get, api),
    ...createRecoverySlice(set, get, api),
    ...createTurnLifecycleSlice(set, get, api),
    ...createSessionSlice(set, get, api),
    ...createSendSlice(set, get, api),
    ...createBranchSlice(set, get, api),
    ...createDiffSlice(set, get, api),
    ...createPaginationSlice(set, get, api),
    ...createWorkspaceSync(set, get, api)
  }))
}
