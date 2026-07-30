import type { RunStatus } from '../../../../shared/run/types'
import type { SessionDetail } from '../../../../shared/session/types'
import {
  mergeFocusedSessionMessages,
  restoreTurnDraftMessage
} from '../../../lib/focusedSessionRecovery'
import { useRunStore } from '../../useRunStore'
import {
  commitMessageList,
  invalidateDiffGeneration,
  isHydrationEpochCurrent,
  nextHydrationEpoch,
  restoreSessionMessages
} from '../internal'
import type { ChatSliceCreator, ChatState, WorkspaceSyncSliceState } from '../types'

interface WorkspaceSyncDependencies {
  buildSessionChangePatch: () => Partial<ChatState>
  buildMessageSequenceResetPatch: () => Partial<ChatState>
}

export function initialWorkspaceSyncState(): Pick<WorkspaceSyncSliceState, 'lastMessagesRevision'> {
  return { lastMessagesRevision: 0 }
}

function isTerminalRunStatus(status: RunStatus): boolean {
  return (
    status === 'completed' ||
    status === 'failed' ||
    status === 'cancelled' ||
    status === 'interrupted'
  )
}

export function createWorkspaceSyncSlice(
  dependencies: WorkspaceSyncDependencies
): ChatSliceCreator<WorkspaceSyncSliceState> {
  return (set, get) => ({
    ...initialWorkspaceSyncState(),

    syncFromWorkspace: (next) => {
      const prev = get()
      const sessionChanged = prev.currentSessionId !== next.currentSessionId
      // revision 是同一会话切换 active path 的权威信号，必须触发重新水合。
      const revisionChanged = next.messagesRevision !== prev.lastMessagesRevision

      const patch: Partial<ChatState> = {
        sessions: next.availableSessions,
        currentSessionId: next.currentSessionId,
        lastMessagesRevision: next.messagesRevision,
        tier1BranchContext: sessionChanged ? null : next.tier1BranchContext
      }

      // 目标会话的运行态与草稿由 snapshot-first 水合恢复，不能沿用旧会话投影。
      if (sessionChanged) {
        Object.assign(patch, dependencies.buildSessionChangePatch())
      }
      set(patch)

      if (!sessionChanged && !revisionChanged) return

      invalidateDiffGeneration()
      set(dependencies.buildMessageSequenceResetPatch())

      const targetSessionId = next.currentSessionId
      const hydrationEpoch = nextHydrationEpoch()
      if (!targetSessionId) return

      void (async () => {
        try {
          // load-session 与 run snapshot 并行启动；应用时先消费 snapshot，
          // 再合并持久化历史，避免运行中切回会话时撕裂覆盖草稿。
          const detailPromise = window.api.invoke('load-session', {
            sessionId: targetSessionId
          }) as Promise<SessionDetail>
          // pullSnapshot 可能先 await；立即登记拒绝观察，避免并发 promise
          // 在稍后 await 原 promise 前被宿主判定为未处理，同时不改变原有 microtask 顺序。
          void detailPromise.catch(() => undefined)
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
            ? !!snapshot && !isTerminalRunStatus(snapshot.status)
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
    }
  })
}
