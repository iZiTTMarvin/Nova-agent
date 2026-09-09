import type { SessionDetail } from '../../../../shared/session/types'
import {
  mergeFocusedSessionMessages,
  restoreTurnDraftMessage
} from '../../../lib/focusedSessionRecovery'
import { selectSessionIsRunning, selectSessionSnapshot, useRunStore } from '../../useRunStore'
import {
  commitMessageList,
  foldLiveTurnIntoMessages,
  invalidateDiffGeneration,
  isHydrationEpochCurrent,
  nextHydrationEpoch,
  restoreSessionMessages
} from '../internal'
import type { ChatSliceCreator, ChatState, WorkspaceSyncSliceState } from '../types'

interface WorkspaceSyncDependencies {
  buildSessionChangePatch: () => Partial<ChatState>
  buildMessageSequenceResetPatch: () => Partial<ChatState>
  onSessionDetailHydrated: (detail: SessionDetail) => void
}

export function initialWorkspaceSyncState(): Pick<WorkspaceSyncSliceState, 'lastMessagesRevision'> {
  return { lastMessagesRevision: 0 }
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
        currentSubagentTask: sessionChanged ? null : prev.currentSubagentTask,
        lastMessagesRevision: next.messagesRevision,
        tier1BranchContext: sessionChanged ? null : next.tier1BranchContext,
        // 灰显标记随会话投影一起处置：切会话即清空（旧会话语境），同会话则跟随主进程广播
        tier1StaleDiffMessageIds: sessionChanged ? [] : next.tier1StaleDiffMessageIds
      }

      // 目标会话的运行态与草稿由 snapshot-first 水合恢复，不能沿用旧会话投影。
      if (sessionChanged) {
        Object.assign(patch, dependencies.buildSessionChangePatch())
      }
      set(patch)
      useRunStore.getState().selectSession(next.currentSessionId)

      if (!sessionChanged && !revisionChanged) return

      invalidateDiffGeneration()
      set(dependencies.buildMessageSequenceResetPatch())

      const targetSessionId = next.currentSessionId
      const hydrationEpoch = nextHydrationEpoch()
      if (sessionChanged && targetSessionId) {
        void import('../../../lib/agentEventGate').then(async ({ isDescendantSessionOf }) => {
          if (!isHydrationEpochCurrent(hydrationEpoch)) return
          await Promise.all(get().sessions
            .filter(session => isDescendantSessionOf(session.id, targetSessionId))
            .map(session => useRunStore.getState().pullSnapshot(session.id)))
        }).catch(err => console.error('[useChatStore] 子任务交互恢复失败:', err))
      }
      void (async () => {
        const { useWorkspaceStore } = await import('../../useWorkspaceStore')
        if (!isHydrationEpochCurrent(hydrationEpoch)) return
        if (!targetSessionId) {
          useWorkspaceStore.getState().setSessionLoading(false)
          return
        }
        if (sessionChanged) {
          useWorkspaceStore.getState().setSessionLoading(true)
        }
        try {
          // load-session 与 run snapshot 并行启动；应用时先消费 snapshot，
          // 再合并持久化历史，避免运行中切回会话时撕裂覆盖草稿。
          const messageIdsAtRequest = new Set(get().messages.map(message => message.id))
          const detailResult = window.api.invoke('load-session', {
            sessionId: targetSessionId
          })
          // invoke 未注册/调用方返回非 Promise 时按加载失败处理，走既有 catch 路径；
          // 否则对 undefined 调 .catch 会让水合 IIFE 静默死亡（分支元信息永不更新）
          if (!detailResult || typeof (detailResult as PromiseLike<unknown>).then !== 'function') {
            throw new Error('load-session 返回了非预期结果')
          }
          const detailPromise = detailResult as Promise<SessionDetail>
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

          const snapshot = selectSessionSnapshot(useRunStore.getState(), targetSessionId)
          const targetRunning = selectSessionIsRunning(useRunStore.getState(), targetSessionId)
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
              const { messages: liveFolded, hasLive } = foldLiveTurnIntoMessages(
                state.messages,
                state.liveTurn
              )
              const messages = mergeFocusedSessionMessages(
                [],
                liveFolded,
                targetRunning ? snapshot?.messageId ?? null : null,
                draft,
                new Set(liveFolded.filter(message => !messageIdsAtRequest.has(message.id)).map(message => message.id))
              )
              return {
                ...commitMessageList(state, { nextMessages: messages, skipWindowTrim: true }),
                currentGeneratingMessageId: targetRunning ? snapshot?.messageId || null : null,
                activeAgentSessionId: targetRunning ? targetSessionId : null,
                ...(hasLive ? { liveTurn: {} } : {})
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
          dependencies.onSessionDetailHydrated(detail)
          set(state => {
            if (
              !isHydrationEpochCurrent(hydrationEpoch) ||
              state.currentSessionId !== targetSessionId
            ) {
              return state
            }
            const { messages: liveFolded, hasLive } = foldLiveTurnIntoMessages(
              state.messages,
              state.liveTurn
            )
            const currentSnapshot = selectSessionSnapshot(useRunStore.getState(), targetSessionId)
            const currentRunning = selectSessionIsRunning(useRunStore.getState(), targetSessionId)
            const messages = mergeFocusedSessionMessages(
              restored,
              liveFolded,
              currentRunning ? currentSnapshot?.messageId ?? state.currentGeneratingMessageId : null,
              currentRunning && currentSnapshot ? restoreTurnDraftMessage(targetSessionId, currentSnapshot) : null,
              new Set(liveFolded.filter(message => !messageIdsAtRequest.has(message.id)).map(message => message.id))
            )
            return {
              ...commitMessageList(state, { nextMessages: messages, skipWindowTrim: true }),
              currentSubagentTask: detail.kind === 'subagent' ? detail.subagentTask ?? null : null,
              hasMoreMessagesAbove: detail.hasMoreMessagesAbove ?? false,
              oldestLoadedMessageId: messages[0]?.id ?? null,
              isLoadingOlderMessages: false,
              suspendHeadTrim: false,
              ...(hasLive ? { liveTurn: {} } : {})
            }
          })

        } catch (err) {
          console.error('[useChatStore] syncFromWorkspace 加载会话消息失败:', err)
        } finally {
          if (isHydrationEpochCurrent(hydrationEpoch)) {
            useWorkspaceStore.getState().setSessionLoading(false)
          }
        }
      })()
    }
  })
}
