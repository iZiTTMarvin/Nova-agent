/**
 * useChatStore — 消息、会话、消息索引、Diff 缓存、流式事件 handler
 *
 * 负责：
 * - 会话列表与当前会话
 * - 消息列表 + 消息索引
 * - 当前正在生成的消息 ID + isGenerating（与消息生命周期强绑定）
 * - 流式工具调用参数累积
 * - 每条消息的 diff 缓存（live / final、loading 状态）
 * - 来自主进程的所有 delta/事件 handler
 *
 * 依赖方向：
 * - 可以读 useAgentStore / useSettingsStore（通过 getState）
 * - 不被 useAgentStore 内部状态依赖（cancel 路径从 agent store 进入后调本 store）
 */
import type {
  Session,
  SessionDetail,
  MessageBlock,
  Mode,
  PermissionDecision
} from '../../shared/session/types'
import { SESSION_HISTORY_PAGE_SIZE } from '../../shared/session/messagePagination'
import { appendTerminalErrorToBlocks } from '../../shared/session/terminalErrorBlocks'
import type { NormalizedUsage } from '../../shared/model/types'
import type { HookEvent } from '../../shared/agent/types'
import type { RendererRecoveryState } from '../../shared/ipc/types'
import type { ImageAttachment } from '../lib/image-attachments'
import {
  mergeFocusedSessionMessages,
  restoreTurnDraftMessage
} from '../lib/focusedSessionRecovery'
import { useRunStore } from './useRunStore'
import type {
  ExtendedMessage,
  PendingPermissionRequest,
  RendererToolBlock
} from './types'
import { MAX_PENDING_MESSAGES } from './chat/constants'
import { createChatStore } from './chat/createChatStore'
import { initialStreamState, resetMessageOnSessionSwitch, resetOnSessionSwitch } from './chat/slices'
import {
  applyDiffReviewStatus,
  buildMessageIndex,
  bumpRevision,
  commitMessageList,
  invalidateHydrationEpoch,
  isHydrationEpochCurrent,
  isTerminalRunStatusLocal,
  nextHydrationEpoch,
  omitRecoveryFieldsForMessage,
  reconcileFocusedSession,
  restoreSessionMessages,
} from './chat/internal'
import type { ChatState } from './chat/types'

export type { ChatState, StreamDelta, StreamDeltaBatch } from './chat/types'

/**
 * Phase 6：turn boundary 自动 dispatch 挂起消息。
 * 当 handleMessageEnd / markRunningAsCancelled 触发时，dequeue 第一条挂起消息并 sendMessage。
 *
 * 注意：get() 必须在 set() 之外调用，保证读到的 pendingUserMessages 是 set 之后的新值。
 * 同时 sendMessage 自身会 set isGenerating=true 并发起 IPC，与 dispatch 行为一致。
 *
 * 异步等待：sendMessage 是 async（含动态 import 与 IPC await），调用方应 await 本函数
 * 以确保 store 状态在 dispatch 后完全稳定（避免测试中读到中间态）。
 */
async function dispatchNextPending(get: () => ChatState): Promise<void> {
  const { pendingUserMessages, sendMessage, isGenerating } = get()
  if (isGenerating) return
  if (pendingUserMessages.length === 0) return
  const [next, ...rest] = pendingUserMessages
  // 同步移除队首，避免被多次 dispatch
  useChatStore.setState({ pendingUserMessages: rest })
  await sendMessage(next.text, next.images)
}

// ── Store 实现 ─────────────────────────────────────────────

export const useChatStore = createChatStore((set, get) => ({
  sessions: [],
  currentSessionId: null,
  lastMessagesRevision: 0,
  pendingBranchMetaReload: false,
  branchForkInProgress: false,
  tier1BranchContext: null,
  isGenerating: false,
  currentGeneratingMessageId: null,
  activeAgentSessionId: null,
  sendInFlight: false,
  messageDiffs: {},
  loadingDiffs: new Set(),
  loadingDiffPlaceholders: {},
  pendingUserMessages: [],
  recoveryState: {},
  recoveryHints: {},
  hookErrors: {},
  rollbackErrors: {},
  hasMoreMessagesAbove: false,
  isLoadingOlderMessages: false,
  oldestLoadedMessageId: null,
  suspendHeadTrim: false,

  loadSessions: async () => {
    try {
      const sessions: Session[] = await window.api.invoke('load-sessions')
      set({ sessions })
    } catch (err) {
      console.error('加载会话列表出错:', err)
    }
  },

  deleteSession: async (sessionId: string) => {
    // PRD §5.1：删除会话统一走 workspace store。当前会话被删时由主进程自动切到下一条，
    // 广播 workspace:changed 后本 store 通过 dispatchWorkspaceChange 同步 messages / sessions。
    try {
      const { useWorkspaceStore } = await import('./useWorkspaceStore')
      await useWorkspaceStore.getState().deleteSession(sessionId)
    } catch (err) {
      console.error('删除会话出错:', err)
    }
  },

  renameSession: async (sessionId: string, title: string) => {
    const { useWorkspaceStore } = await import('./useWorkspaceStore')
    await useWorkspaceStore.getState().renameSession(sessionId, title)
  },

  sendMessage: async (content: string, images?: ImageAttachment[], options?: {
    /** IPC 失败时恢复乐观截断前的消息树 */
    rollbackSnapshot?: { messages: ExtendedMessage[]; messageIndexById: Record<string, number> }
  }): Promise<boolean> => {
    const { currentSessionId, isGenerating, sendInFlight } = get()
    if (isGenerating || sendInFlight) return false

    // 新发消息会改变工作区语义，退出 Tier 1「仅对话历史」视图
    set({ tier1BranchContext: null })

    // PRD §5.1：project 路径统一从 workspace store 读取（单一事实源）
    const { useWorkspaceStore } = await import('./useWorkspaceStore')
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
        }))
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
          const { useWorkspaceStore } = await import('./useWorkspaceStore')
          await useWorkspaceStore.getState().bumpMessagesRevision()
        } catch (reloadErr) {
          console.error('[sendMessage] 回滚后重载会话失败:', reloadErr)
        }
        set(state => ({
          rollbackErrors: {
            ...state.rollbackErrors,
            [userMsg.id]: (err as Error).message
          }
        }))
        return true
      }
      set({ sendInFlight: false, activeAgentSessionId: null, isGenerating: false })
      await get().handleError('msg_err_' + Date.now(), (err as Error).message)
    }
    return true
  },

  finishBranchMetaRefresh: async () => {
    if (!get().pendingBranchMetaReload) return
    set({ pendingBranchMetaReload: false })
    try {
      const { useWorkspaceStore } = await import('./useWorkspaceStore')
      await useWorkspaceStore.getState().bumpMessagesRevision()
    } catch (err) {
      console.error('[useChatStore] finishBranchMetaRefresh 失败:', err)
    }
  },

  dismissTier1BranchNotice: () => {
    set({ tier1BranchContext: null })
  },

  selectSession: async (sessionId: string) => {
    // PRD §5.1：会话切换统一走 workspace store（单一事实源），由主进程广播 workspace:changed
    // 触发 useChatStore 重新加载消息（见 dispatchWorkspaceChange 副作用）。
    // 本方法保留签名以兼容 useAppStore，内部只转发。
    const { useWorkspaceStore } = await import('./useWorkspaceStore')
    await useWorkspaceStore.getState().selectSession(sessionId)
  },

  regenerateAssistant: async (sessionId: string, messageId: string) => {
    if (get().isGenerating) return

    const { messages } = get()
    const assistantIdx = messages.findIndex(m => m.id === messageId)
    const parentUser = assistantIdx > 0 ? messages[assistantIdx - 1] : undefined
    if (parentUser?.role === 'user' && parentUser.blocks?.some(b => b.type === 'image')) {
      set(state => ({
        rollbackErrors: {
          ...state.rollbackErrors,
          [messageId]: '重新生成暂不支持含图片的消息'
        }
      }))
      return
    }

    set({ branchForkInProgress: true })

    try {
      const { useWorkspaceStore } = await import('./useWorkspaceStore')
      await useWorkspaceStore.getState().prepareRegenerate(sessionId, messageId)
      set(state => {
        const { [messageId]: _, ...rest } = state.rollbackErrors
        return { rollbackErrors: rest }
      })
    } catch (err) {
      set({ branchForkInProgress: false })
      const error = err instanceof Error ? err.message : '重新生成失败'
      console.error('重新生成出错:', err)
      set(state => ({
        rollbackErrors: { ...state.rollbackErrors, [messageId]: error }
      }))
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
        messageDiffs: {},
        loadingDiffPlaceholders: {},
        loadingDiffs: new Set(),
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
          const { useWorkspaceStore } = await import('./useWorkspaceStore')
          await useWorkspaceStore.getState().bumpMessagesRevision()
        } catch (reloadErr) {
          console.error('[regenerateAssistant] 回滚后重载会话失败:', reloadErr)
        }
        set(state => ({
          rollbackErrors: {
            ...state.rollbackErrors,
            [messageId]: err instanceof Error ? err.message : '重新生成失败'
          }
        }))
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
      set(state => ({
        rollbackErrors: {
          ...state.rollbackErrors,
          [messageId]: err instanceof Error ? err.message : '重新生成失败'
        }
      }))
    }
  },

  switchBranch: async (sessionId: string, targetMessageId: string) => {
    if (get().isGenerating || get().branchForkInProgress) return

    try {
      const { useWorkspaceStore } = await import('./useWorkspaceStore')
      await useWorkspaceStore.getState().switchBranch(sessionId, targetMessageId)
      set(state => {
        const { [targetMessageId]: _, ...rest } = state.rollbackErrors
        return { rollbackErrors: rest }
      })
    } catch (err) {
      const error = err instanceof Error ? err.message : '切换分支失败'
      console.error('切换分支出错:', err)
      set(state => ({
        rollbackErrors: { ...state.rollbackErrors, [targetMessageId]: error }
      }))
    }
  },

  editResend: async (sessionId: string, messageId: string, newContent: string) => {
    if (get().isGenerating) return

    // 分叉准备 + 发送全程禁止翻页/切分支（prepare 与 send-message 是两段 IPC，中间须锁住）
    set({ branchForkInProgress: true })

    try {
      const { useWorkspaceStore } = await import('./useWorkspaceStore')
      await useWorkspaceStore.getState().prepareEditResend(sessionId, messageId)
      set(state => {
        const { [messageId]: _drop, ...rest } = state.rollbackErrors
        return { rollbackErrors: rest }
      })
    } catch (err) {
      set({ branchForkInProgress: false })
      const error = err instanceof Error ? err.message : '编辑重发失败'
      console.error('编辑重发出错:', err)
      set(state => ({
        rollbackErrors: { ...state.rollbackErrors, [messageId]: error }
      }))
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
        messageDiffs: {},
        loadingDiffPlaceholders: {},
        loadingDiffs: new Set()
      })
    }

    // 3. 复用普通发送：乐观追加新用户消息 + 流式渲染。
    //    appendMessage 在主进程会把新用户消息的 parentId 设为分叉点，天然成兄弟分支。
    set({ pendingBranchMetaReload: true })
    await get().sendMessage(newContent, undefined, { rollbackSnapshot })
  },

  /**
   * 创建新会话（用当前项目工作区，或显式传入 workspaceRoot）
   * PRD §5.1：统一转发到 workspace store，由主进程创建并广播。
   */
  createNewSession: async (workspaceRoot?: string) => {
    const { useWorkspaceStore } = await import('./useWorkspaceStore')
    const ws = useWorkspaceStore.getState()
    const targetProject = workspaceRoot || ws.currentProjectPath
    if (!targetProject) return
    try {
      await ws.createSession(targetProject, ws.currentMode)
    } catch (err) {
      console.error('创建新会话失败:', err)
    }
  },

  rejectFile: async (sessionId: string, messageId: string, filePath: string) => {
    try {
      await window.api.invoke('reject-file', { sessionId, messageId, filePath })
      const cache = get().messageDiffs[messageId]
      if (cache) {
        set(state => ({
          messageDiffs: {
            ...state.messageDiffs,
            [messageId]: applyDiffReviewStatus(cache, filePath, 'rejected')
          }
        }))
      }
    } catch (err) {
      console.error('拒绝文件改动出错:', err)
      throw err
    }
  },

  loadMessageDiffs: async (sessionId: string, messageId: string) => {
    const state = get()
    if (state.messageDiffs[messageId]) return

    set(s => ({
      loadingDiffs: new Set([...s.loadingDiffs, messageId])
    }))

    try {
      const result = await window.api.invoke('get-message-diffs', { sessionId, messageId })
      // 防御：IPC 异常返回时不写坏缓存
      if (!result || !Array.isArray(result.diffs)) {
        set(s => {
          const nextLoading = new Set(s.loadingDiffs)
          nextLoading.delete(messageId)
          return { loadingDiffs: nextLoading }
        })
        return
      }
      set(s => {
        const nextLoading = new Set(s.loadingDiffs)
        nextLoading.delete(messageId)
        const { [messageId]: _drop, ...nextPlaceholders } = s.loadingDiffPlaceholders
        return {
          messageDiffs: { ...s.messageDiffs, [messageId]: { diffs: result.diffs, reviews: result.reviews ?? {}, skippedFiles: result.skippedFiles } },
          loadingDiffs: nextLoading,
          loadingDiffPlaceholders: nextPlaceholders
        }
      })
    } catch (err) {
      console.error('加载 diff 出错:', err)
      set(s => {
        const nextLoading = new Set(s.loadingDiffs)
        nextLoading.delete(messageId)
        return { loadingDiffs: nextLoading }
      })
    }
  },

  acceptFile: async (sessionId: string, messageId: string, filePath: string) => {
    try {
      await window.api.invoke('accept-file', { sessionId, messageId, filePath })
      const cache = get().messageDiffs[messageId]
      if (cache) {
        set(state => ({
          messageDiffs: {
            ...state.messageDiffs,
            [messageId]: applyDiffReviewStatus(cache, filePath, 'accepted')
          }
        }))
      }
    } catch (err) {
      console.error('接受文件出错:', err)
      throw err
    }
  },

  acceptAllFiles: async (sessionId: string, messageId: string, filePaths: string[]) => {
    if (filePaths.length === 0) return
    try {
      await window.api.invoke('accept-all-files', { sessionId, messageId, filePaths })
      const cache = get().messageDiffs[messageId]
      if (cache) {
        // 逐个 apply 后整体写入，避免多次 setState
        let updated = cache
        for (const fp of filePaths) {
          updated = applyDiffReviewStatus(updated, fp, 'accepted')
        }
        set(state => ({
          messageDiffs: { ...state.messageDiffs, [messageId]: updated }
        }))
      }
    } catch (err) {
      console.error('批量接受文件出错:', err)
      throw err
    }
  },

  rejectAllFiles: async (sessionId: string, messageId: string, filePaths: string[]) => {
    if (filePaths.length === 0) return { restored: [], failed: [] }
    try {
      const result = await window.api.invoke('reject-all-files', { sessionId, messageId, filePaths })
      const cache = get().messageDiffs[messageId]
      if (cache) {
        // 仅把恢复成功的文件标记为 rejected；失败的不改状态（UI 可单独提示）
        let updated = cache
        for (const fp of result.restored) {
          updated = applyDiffReviewStatus(updated, fp, 'rejected')
        }
        set(state => ({
          messageDiffs: { ...state.messageDiffs, [messageId]: updated }
        }))
      }
      if (result.failed.length > 0) {
        console.warn('部分文件拒绝失败:', result.failed)
      }
      return result
    } catch (err) {
      console.error('批量拒绝文件出错:', err)
      throw err
    }
  },

  clearMessageDiffs: (messageId: string) => {
    set(state => {
      const { [messageId]: _drop, ...rest } = state.messageDiffs
      return { messageDiffs: rest }
    })
  },

  loadOlderMessages: async () => {
    const {
      currentSessionId,
      oldestLoadedMessageId,
      hasMoreMessagesAbove,
      isLoadingOlderMessages
    } = get()

    if (!currentSessionId || !hasMoreMessagesAbove || isLoadingOlderMessages || !oldestLoadedMessageId) {
      return
    }

    const sessionIdAtStart = currentSessionId
    set({ isLoadingOlderMessages: true })

    try {
      const result = await window.api.invoke('load-session-messages', {
        sessionId: sessionIdAtStart,
        beforeId: oldestLoadedMessageId,
        limit: SESSION_HISTORY_PAGE_SIZE
      })

      if (get().currentSessionId !== sessionIdAtStart) {
        set({ isLoadingOlderMessages: false })
        return
      }

      const older = restoreSessionMessages(result.messages)
      if (older.length === 0) {
        set({ hasMoreMessagesAbove: result.hasMore, isLoadingOlderMessages: false })
        return
      }

      set(state => {
        const merged = [...older, ...state.messages]
        return {
          ...commitMessageList(state, { nextMessages: merged, skipWindowTrim: true }),
          hasMoreMessagesAbove: result.hasMore,
          oldestLoadedMessageId: merged[0]?.id ?? null,
          isLoadingOlderMessages: false,
          suspendHeadTrim: true
        }
      })
    } catch (err) {
      console.error('[useChatStore] loadOlderMessages 失败:', err)
      if (get().currentSessionId === sessionIdAtStart) {
        set({ isLoadingOlderMessages: false })
      }
    }
  },

  /**
   * 工具执行后实时点亮 diff 区域。
   *
   * phase === 'live'：占位信号。后端只发了文件名 + status，没有 hunks。
   *   此时不写 messageDiffs（否则 DiffViewer 会按空 hunks 渲染出 +0 -0 中间态），
   *   仅把 messageId 标记为正在加载。
   * phase === 'final'：完整数据。直接覆盖缓存并清除 loading 标记和 placeholders。
   */
  handleDiffUpdate: (messageId, phase, diffs, reviews) => {
    if (phase === 'live') {
      if (get().messageDiffs[messageId]) return
      const placeholders = diffs.map(d => ({ filePath: d.filePath, status: d.status }))
      set(state => ({
        loadingDiffs: new Set([...state.loadingDiffs, messageId]),
        loadingDiffPlaceholders: {
          ...state.loadingDiffPlaceholders,
          [messageId]: placeholders
        }
      }))
      return
    }

    const nextDiffs = diffs.map(diffMeta => ({
      filePath: diffMeta.filePath,
      status: diffMeta.status,
      hunks: diffMeta.hunks ?? []
    }))

    set(state => {
      const nextLoading = new Set(state.loadingDiffs)
      nextLoading.delete(messageId)
      const { [messageId]: _drop, ...nextPlaceholders } = state.loadingDiffPlaceholders
      return {
        messageDiffs: {
          ...state.messageDiffs,
          [messageId]: {
            diffs: nextDiffs,
            reviews
          }
        },
        loadingDiffs: nextLoading,
        loadingDiffPlaceholders: nextPlaceholders
      }
    })
  },

  handleMessageEnd: async (messageId: string, interrupted?: boolean) => {
    set(state => {
      const nextMessages = state.messages.slice()
      const idx = state.messageIndexById[messageId]
      if (idx !== undefined && nextMessages[idx]) {
        const msg = nextMessages[idx]
        if (interrupted) {
          // Phase 3：取消中断结束时，把该消息的 running tool 块标记为 error
          // 并清空 argumentsRaw、附上 "用户取消执行" 结果。同时标记消息 interrupted。
          const blocks = msg.blocks?.map(b => {
            if (b.type === 'tool' && b.status === 'running') {
              const { argumentsRaw: _drop, ...restBlock } = b as RendererToolBlock
              return { ...restBlock, type: 'tool' as const, status: 'error' as const, result: '用户取消执行' }
            }
            return b
          })
          const toolCalls = msg.toolCalls?.map(tc => {
            if (tc.status === 'running') {
              const { argumentsRaw: _tcDrop, ...restTc } = tc
              return { ...restTc, status: 'error' as const, result: '用户取消执行' }
            }
            return tc
          })
          nextMessages[idx] = bumpRevision({
            ...msg,
            interrupted: true,
            blocks,
            toolCalls,
            turnEndedAt: Date.now()
          })
        } else {
          nextMessages[idx] = bumpRevision({
            ...msg,
            turnEndedAt: Date.now()
          })
        }
      }
      return {
        ...commitMessageList(state, { nextMessages, nextIndex: state.messageIndexById, skipWindowTrim: true }),
        isGenerating: false,
        currentGeneratingMessageId: null,
        activeAgentSessionId: null,
        sendInFlight: false,
        branchForkInProgress: false,
        ...omitRecoveryFieldsForMessage(state, messageId),
        // 中断时清空所有流式工具参数累积
        ...(interrupted ? resetOnSessionSwitch() : {})
      }
    })

    // 后台启动的回复可能缺少早期流式片段；终态始终回到 SessionStore
    // 做按 id 对账。已持久化消息优先，下一轮刚产生的实时消息仍会被保留。
    const sessionIdAtEnd = get().currentSessionId
    if (sessionIdAtEnd) {
      try {
        await reconcileFocusedSession({ getState: get, setState: set }, sessionIdAtEnd)
      } catch (err) {
        console.error('[useChatStore] message_end 终态消息对账失败:', err)
      }
    }

    // 更新当前会话的消息数属性，并自动加载 diff
    const { currentSessionId, sessions, messages } = get()
    if (currentSessionId) {
      get().loadMessageDiffs(currentSessionId, messageId)
      set({
        sessions: sessions.map(s =>
          s.id === currentSessionId ? { ...s, messageCount: messages.length, updatedAt: Date.now() } : s
        )
      })
    }

    // 正常完成路径：清除 agent store 的 5s 兜底定时器。
    // 即使是 interrupted 路径，message-end 已正常到达，定时器也不应再触发。
    const { useAgentStore } = await import('./useAgentStore')
    useAgentStore.getState().clearCancelFallback()

    // Phase 6：turn boundary 自动 dispatch 挂起消息
    await dispatchNextPending(get)

    // 分叉轮次正常结束：补 bump revision 拉取 branch 元信息（翻页器）
    await get().finishBranchMetaRefresh()
  },

  handleError: async (messageId: string, error: string) => {
    const { currentSessionId } = get()
    const activeSessionId = currentSessionId || 'session_default'

    set(state => {
      const idx = state.messageIndexById[messageId]
      const commonFields = {
        isGenerating: false,
        currentGeneratingMessageId: null,
        branchForkInProgress: false,
        // error 路径不发射 message-end，此处同步清理恢复状态，避免残留
        ...omitRecoveryFieldsForMessage(state, messageId)
      }

      if (idx !== undefined && state.messages[idx]) {
        // 消息已存在：保留已流式产出的 blocks/thinking/toolCalls，仅附加错误标记与文案。
        // 禁止清空 blocks（否则用户看到「保护把正常回复弄没了」）。
        const prev = state.messages[idx]!
        const hasBlocks = !!(prev.blocks && prev.blocks.length > 0)
        const nextBlocks = hasBlocks
          ? appendTerminalErrorToBlocks(prev.blocks!, error)
          : prev.blocks
        const nextMessages = state.messages.slice()
        nextMessages[idx] = bumpRevision({
          ...prev,
          // 无 blocks 时用错误文案；有 blocks 时保留原 content，由 blocks 渲染
          content: hasBlocks ? prev.content || '' : error,
          isError: true,
          interrupted: true,
          thinking: prev.thinking,
          blocks: nextBlocks,
          toolCalls: prev.toolCalls
        })
        return {
          ...commitMessageList(state, { nextMessages, nextIndex: state.messageIndexById, skipWindowTrim: true }),
          ...commonFields
        }
      }

      // 罕见 fallback：error 在 message_start 之前到达，此时列表里还没有这条消息，
      // 才走追加路径（保持 messageIndexById 一致性）
      const errorMsg: ExtendedMessage = {
        id: messageId,
        sessionId: activeSessionId,
        role: 'assistant',
        content: error,
        isError: true,
        timestamp: Date.now(),
        _revision: 0
      }
      const nextMessages = [...state.messages, errorMsg]
      return {
        ...commitMessageList(state, {
          nextMessages,
          nextIndex: { ...state.messageIndexById, [messageId]: nextMessages.length - 1 },
          skipWindowTrim: true
        }),
        ...commonFields
      }
    })

    if (currentSessionId) {
      try {
        await reconcileFocusedSession({ getState: get, setState: set }, currentSessionId)
      } catch (reloadError) {
        console.error('[useChatStore] error 终态消息对账失败:', reloadError)
      }
    }

    if (get().pendingBranchMetaReload) {
      await get().finishBranchMetaRefresh()
    }
  },

  handleRecoveryState: (messageId: string, recovery: RendererRecoveryState) => {
    set(state => ({
      recoveryState: { ...state.recoveryState, [messageId]: recovery }
    }))
  },

  handleRecoveryHint: (messageId: string, hint: string, attempt: number) => {
    set(state => ({
      recoveryHints: {
        ...state.recoveryHints,
        [messageId]: [...(state.recoveryHints[messageId] ?? []), { hint, attempt }]
      }
    }))
  },

  handleHookError: (messageId: string, hookEvent: HookEvent, error: string) => {
    set(state => ({
      hookErrors: {
        ...state.hookErrors,
        [messageId]: [...(state.hookErrors[messageId] ?? []), { hookEvent, error }]
      }
    }))
  },

  markRunningAsCancelled: async () => {
    set(state => {
      const nextMessages = state.messages.map(msg => {
        if (!msg.blocks && !msg.toolCalls) return msg
        let changed = false

        const blocks = msg.blocks?.map(b => {
          if (b.type === 'tool' && b.status === 'running') {
            changed = true
            const { argumentsRaw: _drop, ...restBlock } = b as RendererToolBlock
            return { ...restBlock, type: 'tool' as const, status: 'error' as const, result: '用户取消执行' }
          }
          return b
        })

        const toolCalls = msg.toolCalls?.map(tc => {
          if (tc.status === 'running') {
            changed = true
            const { argumentsRaw: _tcDrop, ...restTc } = tc
            return { ...restTc, status: 'error' as const, result: '用户取消执行' }
          }
          return tc
        })

        return changed ? bumpRevision({ ...msg, blocks, toolCalls }) : msg
      })

      return {
        ...commitMessageList(state, { nextMessages, nextIndex: state.messageIndexById, skipWindowTrim: true }),
        isGenerating: false,
        currentGeneratingMessageId: null,
        ...resetOnSessionSwitch()
      }
    })

    // Phase 6：cancel 兜底路径也是 turn boundary，dispatch 挂起消息
    // 同时清除 agent store 的 5s 兜底定时器（虽然 markRunningAsCancelled 本身就是兜底终点，
    // 但保险起见显式清除一次，避免后续 cancel 流程出现多个并存定时器）。
    const { useAgentStore } = await import('./useAgentStore')
    useAgentStore.getState().clearCancelFallback()
    await dispatchNextPending(get)
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
            { text, images: [...images] }
          ]
        }
      }
      return {
        pendingUserMessages: [...state.pendingUserMessages, { text, images: [...images] }]
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
  },


  syncFromWorkspace: (next) => {
    const prev = get()
    const sessionChanged = prev.currentSessionId !== next.currentSessionId
    // 同会话内消息序列变化（回退/切分支）：currentSessionId 不变但 revision 递增。
    // 单纯靠 sessionChanged 会漏掉这类变更，导致「主进程切了、界面没切」。
    const revisionChanged = next.messagesRevision !== prev.lastMessagesRevision

    // 1. 同步 sessions 列表 + currentSessionId + revision + Tier 1 上下文
    const patch: Partial<ChatState> = {
      sessions: next.availableSessions,
      currentSessionId: next.currentSessionId,
      lastMessagesRevision: next.messagesRevision,
      tier1BranchContext: sessionChanged ? null : next.tier1BranchContext
    }

    // 会话切换先清掉旧会话的瞬态投影。目标会话的运行态与草稿由下方
    // snapshot-first 恢复，禁止从可能陈旧的 renderer 缓存同步猜测。
    if (sessionChanged) {
      Object.assign(patch, resetMessageOnSessionSwitch())
      patch.isGenerating = false
      patch.currentGeneratingMessageId = null
      patch.activeAgentSessionId = null
      patch.sendInFlight = false
      patch.pendingUserMessages = []
      patch.branchForkInProgress = false
      Object.assign(patch, resetOnSessionSwitch())
    }

    set(patch)

    // 2. 会话切换 或 同会话内消息序列变化时，重新加载消息（或清空）
    if (sessionChanged || revisionChanged) {
      // 清空 diff 缓存与分页视窗，避免跨会话污染
      set({
        messageDiffs: {},
        loadingDiffPlaceholders: {},
        hasMoreMessagesAbove: false,
        isLoadingOlderMessages: false,
        oldestLoadedMessageId: null,
        suspendHeadTrim: false
      })

      const targetSessionId = next.currentSessionId
      const hydrationEpoch = nextHydrationEpoch()

      if (targetSessionId) {
        void (async () => {
          try {
            // 保持既有 load-session 调用语义，同时并发拉取切入会话的权威 run。
            // 应用时先消费 snapshot，再把历史与当前 run 消息合并，避免撕裂覆盖。
            const detailPromise = window.api.invoke('load-session', {
              sessionId: targetSessionId
            }) as Promise<SessionDetail>
            if (sessionChanged) {
              await useRunStore.getState().pullSnapshot(targetSessionId)
            }
            if (
              !isHydrationEpochCurrent(hydrationEpoch) ||
              get().currentSessionId !== targetSessionId
            ) {
              return
            }

            const targetRunId = useRunStore.getState().activeRunIdBySessionId[targetSessionId]
            const snapshot = sessionChanged && targetRunId
              ? useRunStore.getState().snapshotsByRunId[targetRunId] ?? null
              : null
            const targetRunning = sessionChanged
              ? !!snapshot && !isTerminalRunStatusLocal(snapshot.status)
              : get().isGenerating
            const draft = targetRunning && snapshot
              ? restoreTurnDraftMessage(targetSessionId, snapshot)
              : null

            if (sessionChanged) {
              set(state => {
                if (
                  !isHydrationEpochCurrent(hydrationEpoch) ||
                  state.currentSessionId !== targetSessionId
                ) {
                  return state
                }
                const messages = mergeFocusedSessionMessages(
                  [],
                  state.messages,
                  targetRunning ? snapshot?.messageId ?? null : null,
                  draft
                )
                return {
                  ...commitMessageList(state, { nextMessages: messages, skipWindowTrim: true }),
                  isGenerating: targetRunning,
                  currentGeneratingMessageId: targetRunning ? snapshot?.messageId ?? null : null,
                  activeAgentSessionId: targetRunning ? targetSessionId : null
                }
              })
            }

            const detail = await detailPromise
            if (
              !isHydrationEpochCurrent(hydrationEpoch) ||
              get().currentSessionId !== targetSessionId
            ) {
              return
            }
            const restored = restoreSessionMessages(detail.messages)
            set(state => {
              if (
                !isHydrationEpochCurrent(hydrationEpoch) ||
                state.currentSessionId !== targetSessionId
              ) {
                return state
              }
              const messages = mergeFocusedSessionMessages(
                restored,
                state.messages,
                sessionChanged
                  ? targetRunning ? snapshot?.messageId ?? null : null
                  : state.currentGeneratingMessageId,
                draft
              )
              return {
                ...commitMessageList(state, { nextMessages: messages, skipWindowTrim: true }),
                hasMoreMessagesAbove: detail.hasMoreMessagesAbove ?? false,
                oldestLoadedMessageId: messages[0]?.id ?? null,
                isLoadingOlderMessages: false,
                suspendHeadTrim: false
              }
            })
          } catch (err) {
            console.error('[useChatStore] syncFromWorkspace 加载会话消息失败:', err)
          }
        })()
      } else {
        // 切到"无会话"状态：清空消息
        set(resetMessageOnSessionSwitch())
      }
    }
  }
}))

/**
 * 重置整个 chat store 到默认值。供测试 setup 复用。
 * 不导出给生产代码使用，保留为内部测试辅助。
 */
export function resetChatStoreForTests(): void {
  invalidateHydrationEpoch()
  useChatStore.setState({
    sessions: [],
    currentSessionId: null,
    messages: [],
    messageIndexById: {},
    lastMessagesRevision: 0,
    pendingBranchMetaReload: false,
    branchForkInProgress: false,
    tier1BranchContext: null,
    isGenerating: false,
    currentGeneratingMessageId: null,
    activeAgentSessionId: null,
    sendInFlight: false,
    ...initialStreamState(),
    messageDiffs: {},
    loadingDiffs: new Set(),
    loadingDiffPlaceholders: {},
    pendingUserMessages: [],
    recoveryState: {},
    recoveryHints: {},
    hookErrors: {},
    rollbackErrors: {},
    hasMoreMessagesAbove: false,
    isLoadingOlderMessages: false,
    oldestLoadedMessageId: null,
    suspendHeadTrim: false
  })
}
