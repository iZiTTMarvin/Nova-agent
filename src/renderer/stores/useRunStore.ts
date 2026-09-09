/**
 * useRunStore — RunCoordinator snapshot 的 Renderer 投影
 *
 * 规则：
 * - Renderer 永远不是事实源；启动/重载/切会话先 get-snapshot，再订阅带 sequence 的事件
 * - 检测到序号缺口时重拉 snapshot
 * - 当前会话只渲染自己的 interaction；其他会话用 waitingSessions 徽标
 */
import { create } from 'zustand'
import type { RunSnapshot, PendingInteraction, RunStatus } from '../../shared/run/types'
import type { AskQuestionRequest } from '../../shared/askQuestion/types'
import { projectPendingPlanReview } from '../../shared/planReview'
import type { PendingPlanReview } from '../../shared/planReview'
import type { PendingPermissionRequest } from './types'
import { useAgentStore } from './useAgentStore'

let refreshWaitingBadgesSeq = 0
let refreshWaitingBadgesInFlight: Promise<void> | null = null

export function getWaitingBadgeCountForSnapshot(snapshot: RunSnapshot | null): number {
  if (!snapshot) return 0
  const pendingCount = snapshot.pendingInteractions.filter(
    i => i.status === 'pending' || i.status === 'submitting'
  ).length
  return Math.max(pendingCount, snapshot.status === 'waiting_user' ? 1 : 0)
}

export function areWaitingSessionsEqual(
  a: WaitingSessionBadge[],
  b: WaitingSessionBadge[]
): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  const key = (x: WaitingSessionBadge) => `${x.sessionId}\0${x.runId}\0${x.pendingCount}`
  const countByKey = new Map<string, number>()
  for (const item of a) {
    const k = key(item)
    countByKey.set(k, (countByKey.get(k) ?? 0) + 1)
  }
  for (const item of b) {
    const k = key(item)
    const c = countByKey.get(k)
    if (!c) return false
    if (c === 1) countByKey.delete(k)
    else countByKey.set(k, c - 1)
  }
  return countByKey.size === 0
}

export function arePendingPlanReviewsEqual(
  a: PendingPlanReview | null,
  b: PendingPlanReview | null
): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return (
    a.interactionId === b.interactionId &&
    a.commandVersion === b.commandVersion &&
    a.runId === b.runId &&
    a.sessionId === b.sessionId &&
    a.messageId === b.messageId &&
    a.toolCallId === b.toolCallId &&
    a.source === b.source
  )
}

export function selectPendingPlanReview(
  snapshot: RunSnapshot | null
): PendingPlanReview | null {
  return projectPendingPlanReview(snapshot)
}

/** 用户停止保持沉默；仅非取消原因的中断提示一句。 */
export function getRunInterruptionNotice(snapshot: RunSnapshot | null): string | null {
  if (snapshot?.status !== 'interrupted') return null
  const reason = snapshot.terminalReason ?? ''
  if (reason.startsWith('cancel_execution') || reason.startsWith('force_terminate')) return null
  return '任务意外中断，可直接继续发送消息。'
}

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
  /** 取消动作归属的会话；其他会话视图不呈现取消态、不参与终态确认 */
  cancellingSessionId: string | null
  /** 取消 grace 超时：部分任务未退出 */
  cancelGraceExceeded: boolean
  /** 强制终止目标 runId */
  forceTerminateRunId: string | null

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
  beginLocalCancel: (runId?: string | null) => void
  /** 强制终止 */
  forceTerminate: () => Promise<void>
  resetForTests: () => void
}

const CANCEL_GRACE_MS = 8_000
let cancelGraceTimer: ReturnType<typeof setTimeout> | null = null
const pullInFlightBySession = new Map<string, Promise<void>>()

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

  const planReview = projectPendingPlanReview(snapshot)
  const perm = pending.find(
    i => i.type === 'permission' && i.interactionId !== planReview?.interactionId
  )
  const ask = pending.find(i => i.type === 'askQuestion')

  const agent = useAgentStore.getState()

  if (perm) {
    const p = perm.payload
    agent.handlePermissionRequest({
      messageId: perm.messageId,
      requestId: String(p.requestId ?? perm.interactionId),
      toolName: String(p.toolName ?? 'bash'),
      args: (p.args as Record<string, unknown>) ?? {},
      riskLevel: p.riskLevel === 'high' ? 'high' : 'low',
      reason: String(p.reason ?? ''),
      toolCallIds: p.toolCallIds as string[] | undefined,
      externalPaths: p.externalPaths as string[] | undefined,
      pathAccess: p.pathAccess === 'write' ? 'write' : p.pathAccess === 'read' ? 'read' : undefined,
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

  // 验证权限使用进程内 waiter（带超时），不写入 InteractionInbox，故不从 snapshot 投影。
}

function isTerminalStatus(status: RunStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'interrupted'
}

/**
 * 终态 snapshot 是否归属当前取消动作：
 * - 明确了目标 runId 时按 runId 精确匹配（跨会话到达的终态同样确认取消，不受当前视图影响）；
 * - runId 未知时按取消归属会话判定，归属未知才退回当前会话（水合前的兜底语义）。
 */
function snapshotResolvesCancelling(
  state: RunViewState,
  snapshot: RunSnapshot,
  currentSessionId: string | null
): boolean {
  if (!isTerminalStatus(snapshot.status)) return false
  const targetRunId = state.forceTerminateRunId
  if (targetRunId != null) return targetRunId === snapshot.runId
  if (state.cancellingSessionId != null) return snapshot.sessionId === state.cancellingSessionId
  return currentSessionId == null || snapshot.sessionId === currentSessionId
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
  cancellingSessionId: null,
  cancelGraceExceeded: false,
  forceTerminateRunId: null,

  pullSnapshot: (sessionId: string) => {
    const existing = pullInFlightBySession.get(sessionId)
    if (existing) return existing

    // 同会话进行中的 pull 合并为一次 IPC，避免后发请求抬高 token 使水合读到空快照。
    let promise: Promise<void>
    promise = (async () => {
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
        const received = result?.snapshot ?? null
        const current = get().snapshotsByRunId[get().activeRunIdBySessionId[sessionId]]
        const snap = received && current && (
          received.createdAt < current.createdAt ||
          (received.runId === current.runId && received.sequence < current.sequence)
        ) ? current : received
        // 同一会话更新后的旧响应不能覆盖新事实。
        if (get().pullTokenByRunId[pullKey] !== token) return
        const snapshotsByRunId = snap
          ? { ...get().snapshotsByRunId, [snap.runId]: snap }
          : get().snapshotsByRunId
        const activeRunIdBySessionId = { ...get().activeRunIdBySessionId }
        if (snap) {
          activeRunIdBySessionId[sessionId] = snap.runId
        } else {
          // pull 返回 null：清理该 session 的陈旧 activeRunId
          delete activeRunIdBySessionId[sessionId]
        }
        const isSelected = get().selectedSessionId === sessionId
        const nextWaitingSessions = (result?.waitingSessions ?? []) as WaitingSessionBadge[]
        const shouldWriteWaitingSessions = !areWaitingSessionsEqual(
          get().waitingSessions,
          nextWaitingSessions
        )
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
          ...(shouldWriteWaitingSessions ? { waitingSessions: nextWaitingSessions } : {})
        })

        // 投影交互到 agent store
        const { useChatStore } = await import('./useChatStore')
        const currentSessionId = useChatStore.getState().currentSessionId
        projectInteractionsToAgentStore(snap, currentSessionId)

        // 终态确认取消（按取消归属校验，其他会话的终态 snapshot 不得提前清空）
        if (
          snap &&
          get().cancelling &&
          snapshotResolvesCancelling(get(), snap, currentSessionId)
        ) {
          clearCancelGraceTimer()
          set({
            cancelling: false,
            cancellingSessionId: null,
            cancelGraceExceeded: false,
            forceTerminateRunId: null
          })
          if (snap.sessionId === currentSessionId) {
            useChatStore.getState().markRunningAsCancelled()
          }
        }
      } catch (err) {
        console.error('[useRunStore] pullSnapshot 失败:', err)
      }
    })().finally(() => {
      if (pullInFlightBySession.get(sessionId) === promise) {
        pullInFlightBySession.delete(sessionId)
      }
    })

    pullInFlightBySession.set(sessionId, promise)
    return promise
  },

  handleSnapshotEvent: (snapshot, event) => {
    const state = get()
    const lastSequence = state.lastSequenceByRunId[snapshot.runId] ?? 0
    // 同 runId：迟到/重复旧事件直接忽略，禁止状态回退
    if (event.sequence <= lastSequence) {
      return
    }
    // 序号缺口：重拉权威 snapshot
    if (event.sequence > lastSequence + 1 && lastSequence > 0) {
      void get().pullSnapshot(snapshot.sessionId)
      return
    }

    const previousSnapshotForRun = state.snapshotsByRunId[snapshot.runId] ?? null
    const previousWaitingCount = getWaitingBadgeCountForSnapshot(previousSnapshotForRun)
    const nextWaitingCount = getWaitingBadgeCountForSnapshot(snapshot)
    const shouldRefreshWaiting = previousWaitingCount !== nextWaitingCount

    const active = state.snapshotsByRunId[state.activeRunIdBySessionId[snapshot.sessionId]]
    const isLatestRun = !active || active.runId === snapshot.runId || snapshot.createdAt >= active.createdAt
    const activeRunIdBySessionId = isLatestRun ? {
      ...state.activeRunIdBySessionId,
      [snapshot.sessionId]: snapshot.runId
    } : state.activeRunIdBySessionId
    const isSelected = isLatestRun && (state.selectedSessionId === null || state.selectedSessionId === snapshot.sessionId)
    set({
      // 非当前会话事件只写自己的分桶，绝不篡改兼容 snapshot。
      snapshot: isSelected ? snapshot : state.snapshot,
      lastSequence: isSelected ? event.sequence : state.lastSequence,
      snapshotsByRunId: { ...state.snapshotsByRunId, [snapshot.runId]: snapshot },
      activeRunIdBySessionId,
      lastSequenceByRunId: {
        ...state.lastSequenceByRunId,
        [snapshot.runId]: event.sequence
      }
    })

    void (async () => {
      const { useChatStore } = await import('./useChatStore')
      const currentSessionId = useChatStore.getState().currentSessionId
      // 只投影当前会话的交互
      if (isLatestRun && snapshot.sessionId === currentSessionId) {
        projectInteractionsToAgentStore(snapshot, currentSessionId)
      }
      if (shouldRefreshWaiting) {
        void get().refreshWaitingBadges()
      }

      const cancellingThisRun =
        get().cancelling && snapshotResolvesCancelling(get(), snapshot, currentSessionId)
      if (cancellingThisRun) {
        clearCancelGraceTimer()
        set({
          cancelling: false,
          cancellingSessionId: null,
          cancelGraceExceeded: false,
          forceTerminateRunId: null
        })
        if (isLatestRun && snapshot.sessionId === currentSessionId) {
          useChatStore.getState().markRunningAsCancelled()
        }
      }
    })()
  },

  refreshWaitingBadges: async () => {
    const seq = ++refreshWaitingBadgesSeq
    let promise!: Promise<void>
    promise = (async () => {
      try {
        const list = (await window.api.invoke('run:list-waiting')) as WaitingSessionBadge[]
        if (seq !== refreshWaitingBadgesSeq) return
        const current = get().waitingSessions
        if (areWaitingSessionsEqual(current, list)) return
        set({ waitingSessions: list })
      } catch {
        // 忽略：异常时不清空已有徽标
      } finally {
        if (refreshWaitingBadgesInFlight === promise) {
          refreshWaitingBadgesInFlight = null
        }
      }
    })()
    refreshWaitingBadgesInFlight = promise
    await promise
  },

  beginLocalCancel: (runId?: string | null) => {
    const target = runId ?? null
    if (target) {
      const existing =
        get().snapshotsByRunId[target]
        ?? (get().snapshot?.runId === target ? get().snapshot : null)
      if (existing && isTerminalStatus(existing.status)) return
    }
    // 取消归属会话：优先从 run 快照反查；查不到时保持已有归属（IPC 回传的未知
    // runId 不得覆盖侧边栏取消的会话归属），最后退回当前工作区会话。
    const targetSnap = target
      ? get().snapshotsByRunId[target]
        ?? (get().snapshot?.runId === target ? get().snapshot : null)
      : null
    const cancellingSessionId =
      targetSnap?.sessionId
      ?? (get().cancelling ? get().cancellingSessionId : get().selectedSessionId)
    clearCancelGraceTimer()
    set({
      cancelling: true,
      cancellingSessionId,
      cancelGraceExceeded: false,
      forceTerminateRunId: target
    })
    cancelGraceTimer = setTimeout(() => {
      cancelGraceTimer = null
      if (get().cancelling) {
        set({ cancelGraceExceeded: true })
      }
    }, CANCEL_GRACE_MS)
  },

  forceTerminate: async () => {
    // 强制终止入口只属于取消归属会话的视图；跨会话调用直接忽略，防止误杀其他会话的 run
    const { useChatStore } = await import('./useChatStore')
    const currentSessionId = useChatStore.getState().currentSessionId
    const scopeSession = get().cancellingSessionId
    if (scopeSession != null && currentSessionId != null && scopeSession !== currentSessionId) {
      return
    }
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
          cancellingSessionId: null,
          cancelGraceExceeded: false,
          forceTerminateRunId: null
        })
        if (result.snapshot.sessionId === useChatStore.getState().currentSessionId) {
          useChatStore.getState().markRunningAsCancelled()
        }
      }
    } catch (err) {
      console.error('[useRunStore] forceTerminate 失败:', err)
    }
  },

  resetForTests: () => {
    clearCancelGraceTimer()
    pullInFlightBySession.clear()
    refreshWaitingBadgesSeq = 0
    refreshWaitingBadgesInFlight = null
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
      cancellingSessionId: null,
      cancelGraceExceeded: false,
      forceTerminateRunId: null
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
