import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'
import type { ChatState } from './types'
import type { SessionDetail } from '../../../shared/session/types'
import {
  createBranchSlice,
  createDiffSlice,
  createLiveTurnSlice,
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
  resetLiveTurnOnSessionSwitch,
  resetMessageOnSessionSwitch,
  resetSendOnSessionSwitch,
  resetStreamOnSessionSwitch,
  resetTurnLifecycleOnSessionSwitch
} from './slices'

export interface ChatStoreCompositionDeps {
  onSessionDetailHydrated: (detail: SessionDetail) => void
}

/** 唯一的 create<ChatState> 调用点，负责装配 slice 与跨 owner reset 端口。 */
export function createChatStore(deps: ChatStoreCompositionDeps) {
  const createWorkspaceSync = createWorkspaceSyncSlice({
    onSessionDetailHydrated: deps.onSessionDetailHydrated,
    buildSessionChangePatch: () => ({
      ...resetMessageOnSessionSwitch(),
      ...resetLiveTurnOnSessionSwitch(),
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

  // subscribeWithSelector 不改变现有 selector hook 行为，仅为 transient 订阅铺路：
  // 后续可让活跃项直接订阅 liveTurn 字节，彻底绕开 React 重渲染层级。
  return create<ChatState>()(
    subscribeWithSelector((set, get, api) => ({
      ...createMessageSlice(set, get, api),
      ...createLiveTurnSlice(set, get, api),
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
  )
}
