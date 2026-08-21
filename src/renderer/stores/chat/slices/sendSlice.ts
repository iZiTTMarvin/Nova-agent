import type { MessageBlock } from '../../../../shared/session/types'
import type { ImageAttachment } from '../../../lib/image-attachments'
import type { ExtendedMessage } from '../types'
import { MAX_PENDING_MESSAGES } from '../constants'
import { commitMessageList, setRollbackErrorPatch } from '../internal'
import type { ChatSliceCreator, SendSliceState } from '../types'

export function initialSendState(): Pick<SendSliceState, 'sendInFlight' | 'pendingUserMessages'> {
  return { sendInFlight: false, pendingUserMessages: [] }
}

/**
 * 切会话时丢弃发送中标记与 steering 队列：挂起消息属于旧会话语境，
 * 不得跨会话自动派发。
 */
export function resetSendOnSessionSwitch(): Pick<SendSliceState, 'sendInFlight' | 'pendingUserMessages'> {
  return initialSendState()
}

export const createSendSlice: ChatSliceCreator<SendSliceState> = (set, get) => ({
  ...initialSendState(),

  sendMessage: async (content: string, images?: ImageAttachment[], options?: {
    /** IPC 失败时恢复乐观截断前的消息树 */
    rollbackSnapshot?: { messages: ExtendedMessage[]; messageIndexById: Record<string, number> }
    autoMode?: boolean
  }): Promise<boolean> => {
    const { currentSessionId, isGenerating, sendInFlight, branchForkInProgress } = get()
    if (isGenerating || sendInFlight) return false
    // 分叉准备窗口（prepare → send 两段 IPC 之间）锁住普通发送，避免乐观截断覆盖
    // 刚追加的用户消息；editResend 自身的延续发送（带 rollbackSnapshot）在此窗口放行
    if (branchForkInProgress && !options?.rollbackSnapshot) return false

    // 新发消息会改变工作区语义，退出 Tier 1「仅对话历史」视图
    set({ tier1BranchContext: null })

    // project 路径统一从 workspace store 读取（单一事实源）
    const { useWorkspaceStore } = await import('../../useWorkspaceStore')
    const currentProject = useWorkspaceStore.getState().currentProjectPath
    if (!currentProject) return false

    const activeSessionId = currentSessionId || 'session_default'

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
        isGenerating: true,
        sendInFlight: true,
        activeAgentSessionId: activeSessionId
      }
    })

    try {
      // 2. 异步发起 IPC 消息发送给主进程，主进程开始 Agent 循环并通过事件反馈
      await window.api.invoke('send-message', {
        sessionId: activeSessionId,
        content,
        userMessageId: userMsg.id,
        images: images?.map(img => ({
          fileName: img.fileName,
          data: img.dataUrl,
          mimeType: img.mimeType
        })),
        ...(options?.autoMode !== undefined ? { autoMode: options.autoMode } : {})
      })
    } catch (err) {
      if (options?.rollbackSnapshot) {
        set({
          ...commitMessageList(get(), {
            nextMessages: options.rollbackSnapshot.messages,
            nextIndex: options.rollbackSnapshot.messageIndexById,
            skipWindowTrim: true
          }),
          sendInFlight: false,
          activeAgentSessionId: null,
          isGenerating: false,
          branchForkInProgress: false,
          pendingBranchMetaReload: false
        })
        try {
          const { useWorkspaceStore } = await import('../../useWorkspaceStore')
          await useWorkspaceStore.getState().bumpMessagesRevision()
        } catch (reloadErr) {
          console.error('[sendMessage] 回滚后重载会话失败:', reloadErr)
        }
        set(state => setRollbackErrorPatch(state, userMsg.id, (err as Error).message))
        return true
      }
      set({ sendInFlight: false, activeAgentSessionId: null, isGenerating: false })
      await get().handleError('msg_err_' + Date.now(), (err as Error).message)
    }
    return true
  },

  enqueuePendingMessage: (text, images, autoMode) => {
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
              images: [...images],
              ...(autoMode !== undefined ? { autoMode } : {})
            }
          ]
        }
      }
      return {
        pendingUserMessages: [
          ...state.pendingUserMessages,
          { text, images: [...images], ...(autoMode !== undefined ? { autoMode } : {}) }
        ]
      }
    })
  },

  removePendingMessage: (index) => {
    set(state => ({
      pendingUserMessages: state.pendingUserMessages.filter((_, i) => i !== index)
    }))
  },

  clearPendingMessages: () => {
    set({ pendingUserMessages: [] })
  }
})
