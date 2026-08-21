import type { ChatSliceCreator, BranchSliceState } from '../types'
import {
  buildMessageIndex,
  clearRollbackErrorPatch,
  commitMessageList,
  resetDiffProjectionForBranchChange,
  setRollbackErrorPatch
} from '../internal'

export function initialBranchState(): Pick<
  BranchSliceState,
  'pendingBranchMetaReload' | 'branchForkInProgress' | 'tier1BranchContext'
> {
  return {
    pendingBranchMetaReload: false,
    branchForkInProgress: false,
    tier1BranchContext: null
  }
}

/**
 * 切会话时丢弃分叉瞬态。tier1BranchContext 的跨会话取舍由
 * workspaceSyncSlice 按主进程广播决定，此处只提供分叉锁与刷新标记的清零。
 */
export function resetBranchForkOnSessionSwitch(): Pick<
  BranchSliceState,
  'branchForkInProgress'
> {
  return { branchForkInProgress: false }
}

export const createBranchSlice: ChatSliceCreator<BranchSliceState> = (set, get) => ({
  ...initialBranchState(),

  regenerateAssistant: async (sessionId: string, messageId: string) => {
    // 重生成/编辑/发送/切分支共用同一把入口锁：分叉准备窗口（prepare → send
    // 两段 IPC 之间）的并发操作会覆盖乐观截断视图或漂移 regenerate 身份
    if (get().isGenerating || get().branchForkInProgress || get().sendInFlight) return

    const { messages } = get()
    const assistantIdx = messages.findIndex(m => m.id === messageId)
    const parentUser = assistantIdx > 0 ? messages[assistantIdx - 1] : undefined
    if (parentUser?.role === 'user' && parentUser.blocks?.some(b => b.type === 'image')) {
      set(state => setRollbackErrorPatch(state, messageId, '重新生成暂不支持含图片的消息'))
      return
    }

    set({ branchForkInProgress: true })

    try {
      const { useWorkspaceStore } = await import('../../useWorkspaceStore')
      await useWorkspaceStore.getState().prepareRegenerate(sessionId, messageId)
      set(state => clearRollbackErrorPatch(state, messageId))
    } catch (err) {
      set({ branchForkInProgress: false })
      const error = err instanceof Error ? err.message : '重新生成失败'
      console.error('重新生成出错:', err)
      set(state => setRollbackErrorPatch(state, messageId, error))
      return
    }

    if (assistantIdx !== -1) {
      const preTruncate = {
        messages: [...messages],
        messageIndexById: buildMessageIndex(messages)
      }
      const truncated = messages.slice(0, assistantIdx)
      set({
        ...commitMessageList(get(), { nextMessages: truncated, skipWindowTrim: true }),
        ...resetDiffProjectionForBranchChange(),
        isGenerating: true,
        sendInFlight: true,
        activeAgentSessionId: sessionId
      })

      set({ pendingBranchMetaReload: true })

      try {
        await window.api.invoke('send-message', {
          sessionId,
          content: '',
          regenerate: true
        })
      } catch (err) {
        set({
          ...commitMessageList(get(), {
            nextMessages: preTruncate.messages,
            nextIndex: preTruncate.messageIndexById,
            skipWindowTrim: true
          }),
          branchForkInProgress: false,
          isGenerating: false,
          sendInFlight: false,
          activeAgentSessionId: null,
          pendingBranchMetaReload: false
        })
        try {
          const { useWorkspaceStore } = await import('../../useWorkspaceStore')
          await useWorkspaceStore.getState().bumpMessagesRevision()
        } catch (reloadErr) {
          console.error('[regenerateAssistant] 回滚后重载会话失败:', reloadErr)
        }
        set(state => setRollbackErrorPatch(
          state,
          messageId,
          err instanceof Error ? err.message : '重新生成失败'
        ))
      }
      return
    }

    set({ pendingBranchMetaReload: true, isGenerating: true, sendInFlight: true, activeAgentSessionId: sessionId })

    try {
      await window.api.invoke('send-message', {
        sessionId,
        content: '',
        regenerate: true
      })
    } catch (err) {
      set({
        branchForkInProgress: false,
        isGenerating: false,
        sendInFlight: false,
        activeAgentSessionId: null,
        pendingBranchMetaReload: false
      })
      set(state => setRollbackErrorPatch(
        state,
        messageId,
        err instanceof Error ? err.message : '重新生成失败'
      ))
    }
  },

  switchBranch: async (sessionId: string, targetMessageId: string) => {
    if (get().isGenerating || get().branchForkInProgress || get().sendInFlight) return

    try {
      const { useWorkspaceStore } = await import('../../useWorkspaceStore')
      await useWorkspaceStore.getState().switchBranch(sessionId, targetMessageId)
      set(state => clearRollbackErrorPatch(state, targetMessageId))
    } catch (err) {
      const error = err instanceof Error ? err.message : '切换分支失败'
      console.error('切换分支出错:', err)
      set(state => setRollbackErrorPatch(state, targetMessageId, error))
    }
  },

  editResend: async (sessionId: string, messageId: string, newContent: string) => {
    if (get().isGenerating || get().branchForkInProgress || get().sendInFlight) return

    // 分叉准备 + 发送全程禁止翻页/切分支（prepare 与 send-message 是两段 IPC，中间须锁住）
    set({ branchForkInProgress: true })

    try {
      const { useWorkspaceStore } = await import('../../useWorkspaceStore')
      await useWorkspaceStore.getState().prepareEditResend(sessionId, messageId)
      set(state => clearRollbackErrorPatch(state, messageId))
    } catch (err) {
      set({ branchForkInProgress: false })
      const error = err instanceof Error ? err.message : '编辑重发失败'
      console.error('编辑重发出错:', err)
      set(state => setRollbackErrorPatch(state, messageId, error))
      return
    }

    // 2. 乐观截断视图到分叉点（移除被编辑消息及其之后）。
    //    主进程 prepareEditResend 不 bump messagesRevision，不会触发 reload 覆盖这里。
    const { messages } = get()
    const idx = messages.findIndex(m => m.id === messageId)
    const rollbackSnapshot = {
      messages: [...messages],
      messageIndexById: buildMessageIndex(messages)
    }
    if (idx !== -1) {
      const truncated = messages.slice(0, idx)
      set({
        ...commitMessageList(get(), { nextMessages: truncated, skipWindowTrim: true }),
        // 分叉后旧 diff 缓存与磁盘可能不一致，清空避免误导
        ...resetDiffProjectionForBranchChange()
      })
    }

    // 3. 复用普通发送：乐观追加新用户消息 + 流式渲染。
    //    appendMessage 在主进程会把新用户消息的 parentId 设为分叉点，天然成兄弟分支。
    set({ pendingBranchMetaReload: true })
    await get().sendMessage(newContent, undefined, { rollbackSnapshot })
  },

  finishBranchMetaRefresh: async () => {
    if (!get().pendingBranchMetaReload) return
    try {
      const { useWorkspaceStore } = await import('../../useWorkspaceStore')
      await useWorkspaceStore.getState().bumpMessagesRevision()
      // 刷新成功才清标记：失败时保留，下一次轮次结束（message_end / error）自动重试，
      // 否则落盘的分叉分支信息（徽标/翻页器）会一直陈旧直到重开会话
      set({ pendingBranchMetaReload: false })
    } catch (err) {
      console.error('[useChatStore] finishBranchMetaRefresh 失败:', err)
    }
  },

  dismissTier1BranchNotice: () => {
    set({ tier1BranchContext: null })
  }
})
