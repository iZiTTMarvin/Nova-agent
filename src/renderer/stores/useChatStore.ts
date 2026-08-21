import { createChatStore } from './chat/createChatStore'
import { resetChatStoreStateForTests } from './chat/testing'
import { useSubagentProjectionStore } from '../features/subagents/projection'
import { useComposeStageStore } from '../features/compose/useComposeStageStore'
import { useTodoStore } from '../features/todo/useTodoStore'

export type { ChatState, StreamDelta, StreamDeltaBatch } from './chat/types'

/** 公共入口保持稳定；具体状态与 action 由 chat/ 下的 owner slice 组装。 */
export const useChatStore = createChatStore({
  onSessionDetailHydrated: (detail) => {
    useSubagentProjectionStore.getState().hydrateSessionDetail(detail)
    // compose 阶段表随详情水合：磁盘是事实源（转换先落盘后推送）；
    // 旧会话无表时写 null，阶段条按初始表纯显示。本回调在 epoch 守卫之后触发
    useComposeStageStore.getState().setSessionStages(detail.id, detail.composeStages ?? null)
    useComposeStageStore.getState().setSessionPlanApproval(detail.id, detail.composePlanApproval ?? null)
    // 修复-复审循环计数随详情水合：重开会话后回退入口的上限判定立即可用
    useComposeStageStore.getState().setSessionReviewLoops(detail.id, detail.composeReviewLoops ?? 0)
    // 会话待办随详情水合：重开会话后 TodoPanel 与 compose 阶段条进度立即可见，
    // 不必等下一次 todo_write 推送；空清单不写入，避免制造无数据状态
    if (detail.todos && detail.todos.length > 0) {
      useTodoStore.getState().setSessionTodos(detail.id, detail.todos)
    }
  }
})

/** 仅供测试 setup 复用。 */
export function resetChatStoreForTests(): void {
  resetChatStoreStateForTests(useChatStore)
}
