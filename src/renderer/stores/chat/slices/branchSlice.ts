import { selectSessionIsRunning, useRunStore } from '../../useRunStore'
import type { ChatSliceCreator, BranchSliceState } from '../types'
import {
  buildMessageIndex,
  clearRollbackErrorPatch,
  commitMessageList,
  resetDiffProjectionForBranchChange,
  setRollbackErrorPatch
} from '../internal'
import { slashRejectionText } from '../../../lib/slashRejection'

export function initialBranchState(): Pick<BranchSliceState,
  'pendingBranchMetaReload' | 'branchForkInProgress' | 'tier1BranchContext' | 'tier1StaleDiffMessageIds'> {
  return { pendingBranchMetaReload: false, branchForkInProgress: false, tier1BranchContext: null, tier1StaleDiffMessageIds: [] }
}

export function resetBranchForkOnSessionSwitch(): Pick<BranchSliceState,
  'branchForkInProgress' | 'pendingBranchMetaReload' | 'tier1StaleDiffMessageIds'> {
  return { branchForkInProgress: false, pendingBranchMetaReload: false, tier1StaleDiffMessageIds: [] }
}

export const createBranchSlice: ChatSliceCreator<BranchSliceState> = (set, get) => ({
  ...initialBranchState(),

  regenerateAssistant: async (sessionId, messageId) => {
    if (selectSessionIsRunning(useRunStore.getState(), get().currentSessionId) || get().branchForkInProgress || get().sendInFlight) return
    const { messages } = get()
    const assistantIdx = messages.findIndex(m => m.id === messageId)
    const parentUser = assistantIdx > 0 ? messages[assistantIdx - 1] : undefined
    if (parentUser?.role === 'user' && parentUser.blocks?.some(b => b.type === 'image')) {
      set(state => setRollbackErrorPatch(state, messageId, '重新生成暂不支持含图片的消息'))
      return
    }
    const requestId = crypto.randomUUID()
    const selectedSessionId = get().currentSessionId
    const isCurrentRequest = () => get().sendRequestId === requestId && get().currentSessionId === selectedSessionId
    const rollback = { messages: [...messages], messageIndexById: buildMessageIndex(messages) }
    let truncated = false
    set({ branchForkInProgress: true, sendRequestId: requestId })
    try {
      const { useWorkspaceStore } = await import('../../useWorkspaceStore')
      if (!isCurrentRequest()) return
      await useWorkspaceStore.getState().prepareRegenerate(sessionId, messageId)
      if (!isCurrentRequest()) return
      set(state => clearRollbackErrorPatch(state, messageId))
      if (assistantIdx !== -1) {
        truncated = true
        set({
          ...commitMessageList(get(), { nextMessages: messages.slice(0, assistantIdx), skipWindowTrim: true }),
          ...resetDiffProjectionForBranchChange()
        })
      }
      set({ pendingBranchMetaReload: true, sendInFlight: true, activeAgentSessionId: sessionId })
      const result = await window.api.invoke('send-message', { sessionId, content: '', regenerate: true })
      if (!isCurrentRequest()) return
      if (!result.accepted) throw new Error(slashRejectionText(result.rejection))
    } catch (err) {
      if (!isCurrentRequest()) return
      set({
        ...(truncated ? commitMessageList(get(), { nextMessages: rollback.messages, nextIndex: rollback.messageIndexById, skipWindowTrim: true }) : {}),
        branchForkInProgress: false, sendInFlight: false, activeAgentSessionId: null, pendingBranchMetaReload: false
      })
      if (truncated) {
        try {
          const { useWorkspaceStore } = await import('../../useWorkspaceStore')
          if (!isCurrentRequest()) return
          await useWorkspaceStore.getState().bumpMessagesRevision()
        } catch (reloadErr) {
          console.error('[regenerateAssistant] 回滚后重载会话失败:', reloadErr)
        }
      }
      if (isCurrentRequest()) set(state => setRollbackErrorPatch(state, messageId, err instanceof Error ? err.message : '重新生成失败'))
    } finally {
      if (isCurrentRequest()) set({ sendRequestId: null })
    }
  },

  switchBranch: async (sessionId, targetMessageId) => {
    if (selectSessionIsRunning(useRunStore.getState(), get().currentSessionId) || get().branchForkInProgress || get().sendInFlight) return
    const selectedSessionId = get().currentSessionId
    try {
      const { useWorkspaceStore } = await import('../../useWorkspaceStore')
      await useWorkspaceStore.getState().switchBranch(sessionId, targetMessageId)
      if (get().currentSessionId === selectedSessionId) set(state => clearRollbackErrorPatch(state, targetMessageId))
    } catch (err) {
      if (get().currentSessionId !== selectedSessionId) return
      const error = err instanceof Error ? err.message : '切换分支失败'
      console.error('切换分支出错:', err)
      set(state => setRollbackErrorPatch(state, targetMessageId, error))
    }
  },

  editResend: async (sessionId, messageId, newContent) => {
    if (selectSessionIsRunning(useRunStore.getState(), get().currentSessionId) || get().branchForkInProgress || get().sendInFlight) return
    const requestId = crypto.randomUUID()
    const selectedSessionId = get().currentSessionId
    const isCurrentRequest = () => get().sendRequestId === requestId && get().currentSessionId === selectedSessionId
    set({ branchForkInProgress: true, sendRequestId: requestId })
    try {
      const { useWorkspaceStore } = await import('../../useWorkspaceStore')
      if (!isCurrentRequest()) return
      await useWorkspaceStore.getState().prepareEditResend(sessionId, messageId)
      if (!isCurrentRequest()) return
      set(state => clearRollbackErrorPatch(state, messageId))
    } catch (err) {
      if (!isCurrentRequest()) return
      set({ branchForkInProgress: false, sendRequestId: null })
      const error = err instanceof Error ? err.message : '编辑重发失败'
      console.error('编辑重发出错:', err)
      set(state => setRollbackErrorPatch(state, messageId, error))
      return
    }
    const { messages } = get()
    const idx = messages.findIndex(m => m.id === messageId)
    const rollbackSnapshot = { messages: [...messages], messageIndexById: buildMessageIndex(messages) }
    if (idx !== -1) {
      set({
        ...commitMessageList(get(), { nextMessages: messages.slice(0, idx), skipWindowTrim: true }),
        ...resetDiffProjectionForBranchChange()
      })
    }
    set({ pendingBranchMetaReload: true })
    await get().sendMessage(newContent, undefined, { rollbackSnapshot })
    if (isCurrentRequest()) set({ sendRequestId: null })
  },

  finishBranchMetaRefresh: async () => {
    if (!get().pendingBranchMetaReload) return
    const sessionId = get().currentSessionId
    try {
      const { useWorkspaceStore } = await import('../../useWorkspaceStore')
      await useWorkspaceStore.getState().bumpMessagesRevision()
      if (get().currentSessionId === sessionId) set({ pendingBranchMetaReload: false })
    } catch (err) {
      console.error('[useChatStore] finishBranchMetaRefresh 失败:', err)
    }
  },

  dismissTier1BranchNotice: () => set({ tier1BranchContext: null })
})
