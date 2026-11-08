import { createChatStore } from './chat/createChatStore'
import { resetChatStoreStateForTests } from './chat/testing'
import { useSubagentProjectionStore } from '../features/subagents/projection'
import { useTodoStore } from '../features/todo/useTodoStore'
import { useSettingsStore } from './useSettingsStore'

export type { ChatState, StreamDelta, StreamDeltaBatch } from './chat/types'

/** 公共入口保持稳定；具体状态与 action 由 chat/ 下的 owner slice 组装。 */
export const useChatStore = createChatStore({
  onSessionDetailHydrated: (detail) => {
    if (detail.usage) useSettingsStore.getState().applySessionUsage(detail.usage)
    if (detail.contextBreakdown) useSettingsStore.getState().setContextBreakdown(detail.contextBreakdown)
    useSubagentProjectionStore.getState().hydrateSessionDetail(detail)
    // 待办随详情恢复，不等下一次更新；空清单不制造无数据投影。
    if (detail.todos && detail.todos.length > 0) {
      useTodoStore.getState().setSessionTodos(detail.id, detail.todos)
    }
  }
})

/** 仅供测试 setup 复用。 */
export function resetChatStoreForTests(): void {
  resetChatStoreStateForTests(useChatStore)
}
