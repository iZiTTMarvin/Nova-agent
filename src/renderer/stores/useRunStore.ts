/**
 * useRunStore — RunCoordinator snapshot 的 Renderer 投影
 *
 * 规则：
 * - Renderer 永远不是事实源；启动/重载/切会话先 get-snapshot，再订阅带 sequence 的事件
 * - 检测到序号缺口时重拉 snapshot
 * - 当前会话只渲染自己的 interaction；其他会话用 waitingSessions 徽标
 */
import { create } from 'zustand'
import type { RunSnapshot, PendingInteraction, RunStatus } from '../../runtime/run/types'
import type { AskQuestionRequest } from '../../shared/askQuestion/types'
import type { PendingPermissionRequest } from './types'
import { useAgentStore } from './useAgentStore'

export interface WaitingSessionBadge {
  sessionId: string
  runId: string
  pendingCount: number
}

export interface RunViewState {
  /** 当前 selectedSession 的 active run 快照（兼容现有 UI 调用方） */
  snapshot: RunSnapshot | null
  /** 兼容字段；真实去重按 runId 使用 lastSequenceByRunId。 */
  lastSequence: number
  /** 每个 run 独立保存，不允许其他会话广播覆盖。 */
  snapshotsByRunId: Record<string, RunSnapshot>
  /** 会话当前展示/活动的 run。 */
  activeRunIdBySessionId: Record<string, string>
  /** sequence 只能与同一 run 比较。 */
  lastSequenceByRunId: Record<string, number>
  /** 最近一次 pull 的会话，用于兼容 snapshot 派生。 */
  selectedSessionId: string | null
  /** 每个 run 的拉取版本，拒绝迟到的旧响应。 */
  pullTokenByRunId: Record<string, number>
  /** 各会话「等待你处理」徽标 */
  waitingSessions: WaitingSessionBadge[]
  /** 取消中：等 snapshot 确认终态前保持 */
  cancelling: boolean
  /** 取消 grace 超时：部分任务未退出 */
  cancelGraceExceeded: boolean
  /** 强制终止目标 runId */
  forceTerminateRunId: string | null
  /** interrupted run 恢复入口可见时的 runId */
  interruptedRunId: string | null
  interruptedSteps: Array<{
    toolCallId: string
    toolName: string
    phase: string
  }>

  /** 拉取并应用某会话 snapshot */
  pullSnapshot: (sessionId: string) => Promise<void>
  /** 处理 run:snapshot 推送；缺口则重拉 */
  handleSnapshotEvent: (
    snapshot: RunSnapshot,
    event: { sequence: number; type: string; at: number }
  ) => void
  /** 刷新等待徽标 */
  refreshWaitingBadges: () => Promise<void>
  /** 开始取消（本地 cancelling，等终态） */
  beginLocalCancel: (runId: string) => void
  /** 强制终止 */
  forceTerminate: () => Promise<void>
  /** interrupted 恢复动作 */
  interruptedAction: (action: 'continue' | 'rollback' | 'inspect') => Promise<void>
  clearInterrupted: () => void
  resetForTests: () => void
}

const CANCEL_GRACE_MS = 8_000
let cancelGraceTimer: ReturnType<typeof setTimeout> | null = null

function clearCancelGraceTimer(): void {
  if (cancelGraceTimer !== null) {
    clearTimeout(cancelGraceTimer)
    cancelGraceTimer = null
  }
}

/** 将 snapshot 中的 pending 交互投影到 useAgentStore（当前会话） */
export function projectInteractionsToAgentStore(
  snapshot: RunSnapshot | null,
  currentSessionId: string | null
): void {
  if (!snapshot || !currentSessionId || snapshot.sessionId !== currentSessionId) {
    // 非当前会话：不改 agent store 的 pending（由切会话路径显式处理）
    return
  }

  const pending = snapshot.pendingInteractions.filter(
    i => i.status === 'pending' || i.status === 'submitting'
  )

  const perm = pending.find(i => i.type === 'permission')
  const ask = pending.find(i => i.type === 'askQuestion')
  const ver = pending.find(i => i.type === 'verification')

  const agent = useAgentStore.getState()

  if (perm) {
    const p = perm.payload
    agent.handlePermissionRequest({
      messageId: perm.messageId,
      requestId: String(p.requestId ?? perm.interactionId),
      toolName: String(p.toolName ?? 'bash'),
      args: (p.args as Record<string, unknown>) ?? {},
      riskLevel: (p.riskLevel as 'low' | 'medium' | 'high') ?? 'medium',
      reason: String(p.reason ?? ''),
      toolCallIds: p.toolCallIds as string[] | undefined,
      interactionId: perm.interactionId,
      runId: perm.runId,
      sessionId: perm.sessionId,
      version: perm.version
    } as PendingPermissionRequest)
  } else if (agent.pendingPermissionRequest) {
    // snapshot 无 pending permission → 清空（已回答或取消）
    useAgentStore.setState({ pendingPermissionRequest: null, isSubmittingPermission: false })
  }

  if (ask) {
    const q = ask.payload
    const request: AskQuestionRequest = {
      requestId: String(q.requestId ?? ask.interactionId),
      questions: (q.questions as AskQuestionRequest['questions']) ?? [],
      sessionId: ask.sessionId,
      messageId: ask.messageId,
      runId: ask.runId,
      interactionId: ask.interactionId,
      version: ask.version
    }
    agent.handleAskQuestionRequest(request)
  } else if (agent.pendingAskQuestion) {
    useAgentStore.setState({ pendingAskQuestion: null })
  }

  if (ver) {
    const v = ver.payload
    agent.handleVerificationPermissionRequest({
      requestId: String(v.requestId ?? ver.interactionId),
      command: String(v.command ?? '')
    })
  } else if (agent.pendingVerificationRequest) {
    useAgentStore.setState({ pendingVerificationRequest: null })
  }
}

function isTerminalStatus(status: RunStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'interrupted'
}

export const useRunStore = create<RunViewState>((set, get) => ({
  snapshot: null,
  lastSequence: 0,
  snapshotsByRunId: {},
  activeRunIdBySessionId: {},
  lastSequenceByRunId: {},
  selectedSessionId: null,
  pullTokenByRunId: {},
  waitingSessions: [],
  cancelling: false,
  cancelGraceExceeded: false,
  forceTerminateRunId: null,
  interruptedRunId: null,
  interruptedSteps: [],

  pullSnapshot: async (sessionId: string) => {
    // 会话尚不知道 runId 时，以稳定的 session key 作为拉取令牌。
    const pullKey = `session:${sessionId}`
    const token = (get().pullTokenByRunId[pullKey] ?? 0) + 1
    set({
      selectedSessionId: sessionId,
      pullTokenByRunId: { ...get().pullTokenByRunId, [pullKey]: token }
    })
    try {
      const result = await window.api.invoke('run:get-snapshot', { sessionId })
      // 防御：测试 mock / 旧主进程可能返回 undefined
      const snap = result?.snapshot ?? null
      // 同一会话更新后的旧响应不能覆盖新事实。
      if (get().pullTokenByRunId[pullKey] !== token) return
      const snapshotsByRunId = snap
        ? { ...get().snapshotsByRunId, [snap.runId]: snap }
        : get().snapshotsByRunId
      const activeRunIdBySessionId = snap
        ? { ...get().activeRunIdBySessionId, [sessionId]: snap.runId }
        : get().activeRunIdBySessionId
      const isSelected = get().selectedSessionId === sessionId
      set({
        snapshot: isSelected ? snap : get().snapshot,
        lastSequence: isSelected ? (snap?.sequence ?? 0) : get().lastSequence,
        snapshotsByRunId,
        activeRunIdBySessionId,
        lastSequenceByRunId: snap
          ? { ...get().lastSequenceByRunId, [snap.runId]: snap.sequence }
          : get().lastSequenceByRunId,
        pullTokenByRunId: snap
          ? { ...get().pullTokenByRunId, [snap.runId]: token }
          : get().pullTokenByRunId,
        waitingSessions: result?.waitingSessions ?? [],
        interruptedRunId: snap?.status === 'interrupted' ? snap.runId : get().interruptedRunId,
        interruptedSteps:
          snap?.status === 'interrupted'
            ? (snap.toolCommits ?? []).map(c => ({
                toolCallId: c.toolCallId,
                toolName: c.toolName,
                phase: c.phase
              }))
            : get().interruptedSteps
      })

      // 投影交互到 agent store
      const { useChatStore } = await import('./useChatStore')
      const currentSessionId = useChatStore.getState().currentSessionId
      projectInteractionsToAgentStore(snap, currentSessionId)

      // 终态确认取消
      if (snap && isTerminalStatus(snap.status) && get().cancelling) {
        clearCancelGraceTimer()
        set({
          cancelling: false,
          cancelGraceExceeded: false,
          forceTerminateRunId: null
        })
        // 同步 chat isGenerating
        useChatStore.getState().markRunningAsCancelled()
        useAgentStore.getState().handleTurnState(false, null)
      } else if (snap && !isTerminalStatus(snap.status)) {
        // 非终态：同步 turn 归属
        useAgentStore.getState().handleTurnState(true, snap.sessionId)
      }
    } catch (err) {
      console.error('[useRunStore] pullSnapshot 失败:', err)
    }
  },

  handleSnapshotEvent: (snapshot, event) => {
    const state = get()
    const lastSequence = state.lastSequenceByRunId[snapshot.runId] ?? 0
    // 序号缺口：重拉
    if (event.sequence > lastSequence + 1 && lastSequence > 0) {
      void get().pullSnapshot(snapshot.sessionId)
      return
    }

    const activeRunIdBySessionId = {
      ...state.activeRunIdBySessionId,
      [snapshot.sessionId]: snapshot.runId
    }
    const isSelected = state.selectedSessionId === null || state.selectedSessionId === snapshot.sessionId
    set({
      // 非当前会话事件只写自己的分桶，绝不篡改兼容 snapshot。
      snapshot: isSelected ? snapshot : state.snapshot,
      lastSequence: isSelected ? Math.max(lastSequence, event.sequence) : state.lastSequence,
      snapshotsByRunId: { ...state.snapshotsByRunId, [snapshot.runId]: snapshot },
      activeRunIdBySessionId,
      lastSequenceByRunId: {
        ...state.lastSequenceByRunId,
        [snapshot.runId]: Math.max(lastSequence, event.sequence)
      },
      interruptedRunId: snapshot.status === 'interrupted' ? snapshot.runId : get().interruptedRunId
    })

    void (async () => {
      const { useChatStore } = await import('./useChatStore')
      const currentSessionId = useChatStore.getState().currentSessionId
      // 只投影当前会话的交互
      if (snapshot.sessionId === currentSessionId) {
        projectInteractionsToAgentStore(snapshot, currentSessionId)
      }
      // 刷新徽标
      void get().refreshWaitingBadges()

      const cancellingThisRun = get().cancelling &&
        (get().forceTerminateRunId === null || get().forceTerminateRunId === snapshot.runId)
      if (cancellingThisRun && isTerminalStatus(snapshot.status)) {
        clearCancelGraceTimer()
        set({
          cancelling: false,
          cancelGraceExceeded: false,
          forceTerminateRunId: null
        })
        useChatStore.getState().markRunningAsCancelled()
        useAgentStore.getState().handleTurnState(false, null)
      } else if (!isTerminalStatus(snapshot.status)) {
        useAgentStore.getState().handleTurnState(true, snapshot.sessionId)
      } else {
        useAgentStore.getState().handleTurnState(false, null)
      }
    })()
  },

  refreshWaitingBadges: async () => {
    try {
      const list = await window.api.invoke('run:list-waiting')
      set({ waitingSessions: list })
    } catch {
      // 忽略
    }
  },

  beginLocalCancel: (runId: string) => {
    clearCancelGraceTimer()
    set({
      cancelling: true,
      cancelGraceExceeded: false,
      forceTerminateRunId: runId
    })
    cancelGraceTimer = setTimeout(() => {
      cancelGraceTimer = null
      if (get().cancelling) {
        set({ cancelGraceExceeded: true })
      }
    }, CANCEL_GRACE_MS)
  },

  forceTerminate: async () => {
    const selectedSessionId = get().selectedSessionId
    const selectedRunId = selectedSessionId
      ? get().activeRunIdBySessionId[selectedSessionId]
      : get().snapshot?.runId
    const runId = get().forceTerminateRunId ?? selectedRunId
    if (!runId) return
    try {
      const result = await window.api.invoke('run:force-terminate', { runId })
      if (result.snapshot) {
        get().handleSnapshotEvent(result.snapshot, {
          sequence: result.snapshot.sequence,
          type: 'force_terminate',
          at: Date.now()
        })
      }
      // 未收到终态时继续显示 cancelling，不能用本地状态掩盖后台仍在执行。
      if (result.snapshot && isTerminalStatus(result.snapshot.status)) {
        clearCancelGraceTimer()
        set({
          cancelling: false,
          cancelGraceExceeded: false,
          forceTerminateRunId: null
        })
        const { useChatStore } = await import('./useChatStore')
        useChatStore.getState().markRunningAsCancelled()
        useAgentStore.getState().handleTurnState(false, null)
      }
    } catch (err) {
      console.error('[useRunStore] forceTerminate 失败:', err)
    }
  },

  interruptedAction: async (action) => {
    const runId = get().interruptedRunId ?? get().snapshot?.runId
    if (!runId) return
    try {
      const result = await window.api.invoke('run:interrupted-action', { runId, action })
      if (result.steps) {
        set({
          interruptedSteps: result.steps.map(c => ({
            toolCallId: c.toolCallId,
            toolName: c.toolName,
            phase: c.phase
          }))
        })
      }
      if (result.snapshot) {
        set({ snapshot: result.snapshot })
      }
      if (action === 'continue' || action === 'rollback') {
        // 保留 inspect 结果；continue 后清 interrupted 标记由用户发消息衔接
        if (action === 'rollback') {
          set({ interruptedRunId: null })
        }
      }
    } catch (err) {
      console.error('[useRunStore] interruptedAction 失败:', err)
    }
  },

  clearInterrupted: () => {
    set({ interruptedRunId: null, interruptedSteps: [] })
  },

  resetForTests: () => {
    clearCancelGraceTimer()
    set({
      snapshot: null,
      lastSequence: 0,
      snapshotsByRunId: {},
      activeRunIdBySessionId: {},
      lastSequenceByRunId: {},
      selectedSessionId: null,
      pullTokenByRunId: {},
      waitingSessions: [],
      cancelling: false,
      cancelGraceExceeded: false,
      forceTerminateRunId: null,
      interruptedRunId: null,
      interruptedSteps: []
    })
  }
}))

/** 从 PendingInteraction 构造 AskQuestionRequest（测试辅助） */
export function interactionToAskRequest(i: PendingInteraction): AskQuestionRequest {
  return {
    requestId: String(i.payload.requestId ?? i.interactionId),
    questions: (i.payload.questions as AskQuestionRequest['questions']) ?? [],
    sessionId: i.sessionId,
    messageId: i.messageId,
    runId: i.runId,
    interactionId: i.interactionId,
    version: i.version
  }
}
