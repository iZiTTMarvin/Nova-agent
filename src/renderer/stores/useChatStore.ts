/**
 * useChatStore — chat store 组装入口。
 *
 * 领域 slice 负责消息、流式、恢复态、轮次终态、会话 CRUD、发送与分叉；
 * 本入口负责组装，以及尚由同一 Owner 管理的 diff、分页、工作区同步和会话水合。
 *
 * 依赖方向：
 * - 可以读 useAgentStore / useSettingsStore（通过 getState）
 * - 不被 useAgentStore 内部状态依赖（cancel 路径从 agent store 进入后调本 store）
 */
import type {
  SessionDetail,
  Mode,
  PermissionDecision
} from '../../shared/session/types'
import { SESSION_HISTORY_PAGE_SIZE } from '../../shared/session/messagePagination'
import type { NormalizedUsage } from '../../shared/model/types'
import {
  mergeFocusedSessionMessages,
  restoreTurnDraftMessage
} from '../lib/focusedSessionRecovery'
import { useRunStore } from './useRunStore'
import type {
  PendingPermissionRequest
} from './types'
import { createChatStore } from './chat/createChatStore'
import {
  initialBranchState,
  initialRecoveryState,
  initialSendState,
  initialSessionState,
  initialStreamState,
  initialTurnLifecycleState,
  resetBranchForkOnSessionSwitch,
  resetMessageOnSessionSwitch,
  resetSendOnSessionSwitch,
  resetStreamOnSessionSwitch,
  resetTurnLifecycleOnSessionSwitch
} from './chat/slices'
import {
  applyDiffReviewStatus,
  commitMessageList,
  invalidateHydrationEpoch,
  isHydrationEpochCurrent,
  isTerminalRunStatusLocal,
  nextHydrationEpoch,
  restoreSessionMessages,
} from './chat/internal'
import type { ChatState } from './chat/types'

export type { ChatState, StreamDelta, StreamDeltaBatch } from './chat/types'

// ── Store 实现 ─────────────────────────────────────────────

export const useChatStore = createChatStore((set, get) => ({
  lastMessagesRevision: 0,
  messageDiffs: {},
  loadingDiffs: new Set(),
  loadingDiffPlaceholders: {},
  rollbackErrors: {},
  hasMoreMessagesAbove: false,
  isLoadingOlderMessages: false,
  oldestLoadedMessageId: null,
  suspendHeadTrim: false,

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
      Object.assign(patch, resetTurnLifecycleOnSessionSwitch())
      Object.assign(patch, resetSendOnSessionSwitch())
      Object.assign(patch, resetBranchForkOnSessionSwitch())
      Object.assign(patch, resetStreamOnSessionSwitch())
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
    ...initialSessionState(),
    messages: [],
    messageIndexById: {},
    lastMessagesRevision: 0,
    ...initialBranchState(),
    ...initialTurnLifecycleState(),
    ...initialSendState(),
    ...initialStreamState(),
    messageDiffs: {},
    loadingDiffs: new Set(),
    loadingDiffPlaceholders: {},
    ...initialRecoveryState(),
    rollbackErrors: {},
    hasMoreMessagesAbove: false,
    isLoadingOlderMessages: false,
    oldestLoadedMessageId: null,
    suspendHeadTrim: false
  })
}
