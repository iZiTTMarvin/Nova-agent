import type { RunSnapshot, RunStatus } from '../../../../shared/run/types'
import type { SessionDetail } from '../../../../shared/session/types'
import {
  mergeFocusedSessionMessages,
  restoreTurnDraftMessage
} from '../../../lib/focusedSessionRecovery'
import { useRunStore } from '../../useRunStore'
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

      if (!sessionChanged && !revisionChanged) return

      invalidateDiffGeneration()
      set(dependencies.buildMessageSequenceResetPatch())

      const targetSessionId = next.currentSessionId
      const hydrationEpoch = nextHydrationEpoch()
      if (!targetSessionId) return

      void (async () => {
        const { useWorkspaceStore } = await import('../../useWorkspaceStore')
        if (sessionChanged) {
          useWorkspaceStore.getState().setSessionLoading(true)
        }
        try {
          // load-session 与 run snapshot 并行启动；应用时先消费 snapshot，
          // 再合并持久化历史，避免运行中切回会话时撕裂覆盖草稿。
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

          const targetRunId = useRunStore.getState().activeRunIdBySessionId[targetSessionId]
          let snapshot = sessionChanged && targetRunId
            ? useRunStore.getState().snapshotsByRunId[targetRunId] ?? null
            : null

          // 水合前终态复核：pull 快照可能截于轮次终态提交之前（收尾会话的
          // message-end 与 pull 响应竞态），直接采用会把已结束轮次复活成
          // isGenerating=true。向主进程复核一次权威快照：同一 run 已终态则以终态为准。
          if (sessionChanged && targetRunId && snapshot && !isTerminalRunStatus(snapshot.status)) {
            try {
              const verified = (await window.api.invoke('run:get-snapshot', {
                sessionId: targetSessionId
              })) as { snapshot?: RunSnapshot | null } | null
              if (verified?.snapshot && verified.snapshot.runId === targetRunId) {
                snapshot = verified.snapshot
              }
            } catch {
              // 复核失败沿用 pull 快照，不阻塞水合
            }
          }

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
              const { messages: liveFolded, hasLive } = foldLiveTurnIntoMessages(
                state.messages,
                state.liveTurn
              )
              const messages = mergeFocusedSessionMessages(
                [],
                liveFolded,
                targetRunning ? snapshot?.messageId ?? null : null,
                draft
              )
              return {
                ...commitMessageList(state, { nextMessages: messages, skipWindowTrim: true }),
                isGenerating: targetRunning,
                currentGeneratingMessageId: targetRunning ? snapshot?.messageId ?? null : null,
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
            const messages = mergeFocusedSessionMessages(
              restored,
              liveFolded,
              sessionChanged
                ? targetRunning ? snapshot?.messageId ?? null : null
                : state.currentGeneratingMessageId,
              draft
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

          // 切会话后该项目仍在场：子代理 pending 权限请求不随事件重放
          // （重启/切回），从后代 run snapshot 恢复投影到父会话权限条
          if (sessionChanged && get().currentSessionId === targetSessionId) {
            const { projectDescendantPendingPermissions } = await import('../../useAgentStore')
            await projectDescendantPendingPermissions(targetSessionId)
          }
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
