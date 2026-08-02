import { createChatStore } from './chat/createChatStore'
import { resetChatStoreStateForTests } from './chat/testing'
import { useSubagentProjectionStore } from '../features/subagents/projection'

export type { ChatState, StreamDelta, StreamDeltaBatch } from './chat/types'

/** 公共入口保持稳定；具体状态与 action 由 chat/ 下的 owner slice 组装。 */
export const useChatStore = createChatStore({
  onSessionDetailHydrated: (detail) => {
    useSubagentProjectionStore.getState().hydrateSessionDetail(detail)
  }
})

/** 仅供测试 setup 复用。 */
export function resetChatStoreForTests(): void {
  resetChatStoreStateForTests(useChatStore)
}
