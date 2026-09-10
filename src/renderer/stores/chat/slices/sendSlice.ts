import { selectSessionIsRunning, useRunStore } from '../../useRunStore'
import type { MessageBlock } from '../../../../shared/session/types'
import type { ExtendedMessage } from '../types'
import { MAX_PENDING_MESSAGES } from '../constants'
import { commitMessageList, dispatchNextPendingMessage, setRollbackErrorPatch } from '../internal'
import { slashRejectionText } from '../../../lib/slashRejection'
import type { ChatSliceCreator, SendSliceState } from '../types'

export function initialSendState(): Pick<SendSliceState, 'sendInFlight' | 'sendRequestId' | 'pendingUserMessages'> {
  return { sendInFlight: false, sendRequestId: null, pendingUserMessages: [] }
}

/**
 * 切会话时丢弃发送中标记与 steering 队列：挂起消息属于旧会话语境，
 * 不得跨会话自动派发。
 */
export function resetSendOnSessionSwitch(): Pick<SendSliceState, 'sendInFlight' | 'sendRequestId' | 'pendingUserMessages'> {
  return initialSendState()
}

export const createSendSlice: ChatSliceCreator<SendSliceState> = (set, get) => ({
  ...initialSendState(),

  sendMessage: async (content, images, options): Promise<boolean> => {
    const { currentSessionId, sendInFlight, branchForkInProgress } = get()
    if (selectSessionIsRunning(useRunStore.getState(), currentSessionId) || sendInFlight) return false
    // 分叉准备窗口（prepare → send 两段 IPC 之间）锁住普通发送，避免乐观截断覆盖
    // 刚追加的用户消息；editResend 自身的延续发送（带 rollbackSnapshot）在此窗口放行
    if (branchForkInProgress && !options?.rollbackSnapshot) return false

    // 新发消息会改变工作区语义，退出 Tier 1「仅对话历史」视图
    set({ tier1BranchContext: null })

    // project 路径统一从 workspace store 读取（单一事实源）
    const { useWorkspaceStore } = await import('../../useWorkspaceStore')
    const currentProject = useWorkspaceStore.getState().currentProjectPath
    if (!currentProject) return false
    const latest = get()
    if (latest.currentSessionId !== currentSessionId || selectSessionIsRunning(useRunStore.getState(), currentSessionId) || latest.sendInFlight) return false
    if (latest.branchForkInProgress && !options?.rollbackSnapshot) return false

    const activeSessionId = currentSessionId || 'session_default'
    const requestId = crypto.randomUUID()
    const isCurrentRequest = () => get().sendRequestId === requestId && get().currentSessionId === currentSessionId

    // 构建用户消息 blocks（含图片 ImageBlock）
    const blocks: MessageBlock[] = []
    if (content.trim()) {
      blocks.push({ type: 'text', content })
    }
    if (images && images.length > 0) {
      for (const img of images) {
        blocks.push({
          type: 'image',
          fileName: img.fileName,
          dataUrl: img.dataUrl,
          mimeType: img.mimeType
        })
      }
    }

    // 1. 创建并追加用户消息
    const userMsg: ExtendedMessage = {
      id: 'msg_' + Date.now() + '_user',
      sessionId: activeSessionId,
      role: 'user',
      content,
      blocks: blocks.length > 0 ? blocks : undefined,
      timestamp: Date.now(),
      _revision: 0
    }

    set(state => {
      const nextMessages = [...state.messages, userMsg]
      return {
        ...commitMessageList(state, {
          nextMessages,
          nextIndex: { ...state.messageIndexById, [userMsg.id]: nextMessages.length - 1 }
        }),
        sendInFlight: true,
        sendRequestId: requestId,
        activeAgentSessionId: activeSessionId
      }
    })

    options?.onAccepted?.()
    try {
      // 2. 异步发起 IPC 消息发送给主进程，主进程开始 Agent 循环并通过事件反馈
      const result = await window.api.invoke('send-message', {
        sessionId: activeSessionId,
        content,
        userMessageId: userMsg.id,
        images: images?.map(img => ({
          fileName: img.fileName,
          data: img.dataUrl,
          mimeType: img.mimeType
        }))
      })
      if (!isCurrentRequest()) return true
      if (!result.accepted) {
        // 本地拒绝：输入未落盘。普通发送移除乐观用户消息、恢复草稿，
        // 错误消息跳过对账直接展示（无落盘就无可对账的新状态）；
        // 分叉延续发送仍抛给快照回滚统一路径。
        if (!options?.rollbackSnapshot) {
          set(state => ({
            ...commitMessageList(state, {
              nextMessages: state.messages.filter(m => m.id !== userMsg.id),
              skipWindowTrim: true
            })
          }))
          options?.onRejected?.(content)
          set({ sendInFlight: false, activeAgentSessionId: null })
          await get().handleError('msg_err_' + Date.now(), slashRejectionText(result.rejection), { skipReconcile: true })
          return true
        }
        throw new Error(slashRejectionText(result.rejection))
      }
      // IPC 在轮次结束或入队后才返回 accepted，发送锁不能再依赖快照到达。
      if (isCurrentRequest()) set({ sendInFlight: false })
    } catch (err) {
      if (!isCurrentRequest()) return true
      if (options?.rollbackSnapshot) {
        set({
          ...commitMessageList(get(), {
            nextMessages: options.rollbackSnapshot.messages,
            nextIndex: options.rollbackSnapshot.messageIndexById,
            skipWindowTrim: true
          }),
          sendInFlight: false,
          activeAgentSessionId: null,
          branchForkInProgress: false,
          pendingBranchMetaReload: false
        })
        try {
          const { useWorkspaceStore } = await import('../../useWorkspaceStore')
          await useWorkspaceStore.getState().bumpMessagesRevision()
        } catch (reloadErr) {
          console.error('[sendMessage] 回滚后重载会话失败:', reloadErr)
        }
        if (!isCurrentRequest()) return true
        set(state => setRollbackErrorPatch(state, userMsg.id, (err as Error).message))
        return true
      }
      set({ sendInFlight: false, activeAgentSessionId: null })
      await get().handleError('msg_err_' + Date.now(), (err as Error).message)
    } finally {
      if (isCurrentRequest()) set({ sendRequestId: null })
    }
    return true
  },

  enqueuePendingMessage: (text, images) => {
    set(state => {
      // 防止用户疯狂输入导致队列无限增长。超过上限时丢弃最早的项。
      if (state.pendingUserMessages.length >= MAX_PENDING_MESSAGES) {
        const dropped = state.pendingUserMessages.length - MAX_PENDING_MESSAGES + 1
        console.warn(`[enqueuePendingMessage] 队列已满（${MAX_PENDING_MESSAGES}），丢弃最早的 ${dropped} 条`)
        return {
          pendingUserMessages: [
            ...state.pendingUserMessages.slice(dropped),
            {
              text,
              images: [...images]
            }
          ]
        }
      }
      return {
        pendingUserMessages: [
          ...state.pendingUserMessages,
          { text, images: [...images] }
        ]
      }
    })
  },

  sendNextPendingMessage: () => dispatchNextPendingMessage({ getState: get, setState: set }),

  removePendingMessage: (index) => {
    set(state => ({
      pendingUserMessages: state.pendingUserMessages.filter((_, i) => i !== index)
    }))
  },

  clearPendingMessages: () => {
    set({ pendingUserMessages: [] })
  }
})
