import { create } from 'zustand'
import type { RunSnapshot, PendingInteraction } from '../../shared/run/types'
import { isTerminalRunStatus } from '../../shared/run/types'
import type { AskQuestionRequest } from '../../shared/askQuestion/types'
import { projectPendingPlanReview } from '../../shared/planReview'
import type { PendingPlanReview } from '../../shared/planReview'
import type { PendingPermissionRequest } from './types'
import { useAgentStore } from './useAgentStore'

let refreshWaitingBadgesSeq = 0

export function getWaitingBadgeCountForSnapshot(snapshot: RunSnapshot | null): number {
  if (!snapshot) return 0
  const pendingCount = snapshot.pendingInteractions.filter(
    i => i.status === 'pending' || i.status === 'submitting'
  ).length
  return Math.max(pendingCount, snapshot.status === 'waiting_user' ? 1 : 0)
}

export function areWaitingSessionsEqual(a: WaitingSessionBadge[], b: WaitingSessionBadge[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  const key = (x: WaitingSessionBadge) => `${x.sessionId}\0${x.runId}\0${x.pendingCount}`
  const counts = new Map<string, number>()
  for (const item of a) counts.set(key(item), (counts.get(key(item)) ?? 0) + 1)
  for (const item of b) {
    const count = counts.get(key(item))
    if (!count) return false
    if (count === 1) counts.delete(key(item))
    else counts.set(key(item), count - 1)
  }
  return counts.size === 0
}

export function arePendingPlanReviewsEqual(a: PendingPlanReview | null, b: PendingPlanReview | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return a.interactionId === b.interactionId && a.commandVersion === b.commandVersion &&
    a.runId === b.runId && a.sessionId === b.sessionId && a.messageId === b.messageId &&
    a.toolCallId === b.toolCallId && a.source === b.source
}

export function selectPendingPlanReview(snapshot: RunSnapshot | null): PendingPlanReview | null {
  return projectPendingPlanReview(snapshot)
}

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
  snapshot: RunSnapshot | null
  lastSequence: number
  snapshotsByRunId: Record<string, RunSnapshot>
  activeRunIdBySessionId: Record<string, string>
  lastSequenceByRunId: Record<string, number>
  /** 仅由工作区会话选择更新，查询和广播不能改变焦点。 */
  selectedSessionId: string | null
  pullTokenBySessionId: Record<string, number>
  waitingSessions: WaitingSessionBadge[]
  cancelling: boolean
  cancellingSessionId: string | null
  cancelGraceExceeded: boolean
  forceTerminateRunId: string | null
  selectSession: (sessionId: string | null) => void
  pullSnapshot: (sessionId: string) => Promise<void>
  handleSnapshotEvent: (snapshot: RunSnapshot, event: { sequence: number; type: string; at: number }) => void
  refreshInteractionProjection: () => Promise<void>
  refreshWaitingBadges: () => Promise<void>
  beginLocalCancel: (runId?: string | null) => void
  forceTerminate: () => Promise<void>
  resetForTests: () => void
}

export function selectSessionSnapshot(state: RunViewState, sessionId: string | null): RunSnapshot | null {
  return sessionId ? state.snapshotsByRunId[state.activeRunIdBySessionId[sessionId]] ?? null : null
}

export function selectSessionIsRunning(state: RunViewState, sessionId: string | null): boolean {
  const snapshot = selectSessionSnapshot(state, sessionId)
  return snapshot !== null && !isTerminalRunStatus(snapshot.status)
}

const CANCEL_GRACE_MS = 8_000
let cancelGraceTimer: ReturnType<typeof setTimeout> | null = null
const pullInFlightBySession = new Map<string, Promise<void>>()

function clearCancelGraceTimer(): void {
  if (cancelGraceTimer !== null) clearTimeout(cancelGraceTimer)
  cancelGraceTimer = null
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : undefined
}

function interactionToPermission(i: PendingInteraction): PendingPermissionRequest {
  const p = i.payload
  return {
    messageId: i.messageId,
    requestId: typeof p.requestId === 'string' ? p.requestId : i.interactionId,
    toolName: typeof p.toolName === 'string' ? p.toolName : '未知工具',
    args: p.args && typeof p.args === 'object' && !Array.isArray(p.args) ? p.args as Record<string, unknown> : {},
    riskLevel: p.riskLevel === 'high' ? 'high' : 'low',
    reason: typeof p.reason === 'string' ? p.reason : '',
    commands: stringArray(p.commands),
    toolCallIds: stringArray(p.toolCallIds),
    externalPaths: stringArray(p.externalPaths),
    pathAccess: p.pathAccess === 'write' ? 'write' : p.pathAccess === 'read' ? 'read' : undefined,
    interactionId: i.interactionId,
    runId: i.runId,
    sessionId: i.sessionId,
    version: i.version
  }
}

/** 父请求优先，其余请求按创建顺序从同一份快照缓存投影。 */
export function projectInteractionsToAgentStore(
  snapshot: RunSnapshot | null,
  currentSessionId: string | null,
  descendants: RunSnapshot[] = []
): void {
  if (!currentSessionId || (snapshot && snapshot.sessionId !== currentSessionId)) return
  const pendingOf = (s: RunSnapshot) => isTerminalRunStatus(s.status) ? [] : s.pendingInteractions.filter(
    i => i.runId === s.runId && i.sessionId === s.sessionId && (i.status === 'pending' || i.status === 'submitting')
  )
  const own = snapshot ? pendingOf(snapshot) : []
  const planReview = projectPendingPlanReview(snapshot)
  const permissions = [
    ...own.filter(i => i.type === 'permission' && i.interactionId !== planReview?.interactionId),
    ...descendants.flatMap(s => pendingOf(s).filter(i =>
      i.type === 'permission' && i.interactionId !== projectPendingPlanReview(s)?.interactionId
    )).sort((a, b) => a.createdAt - b.createdAt || a.interactionId.localeCompare(b.interactionId))
  ]
  const agent = useAgentStore.getState()
  const permission = permissions[0]
  if (permission) agent.handlePermissionRequest(interactionToPermission(permission))
  else if (agent.pendingPermissionRequest) {
    useAgentStore.setState({ pendingPermissionRequest: null, isSubmittingPermission: false, permissionError: null })
  }
  const ask = own.find(i => i.type === 'askQuestion')
  if (ask) agent.handleAskQuestionRequest(interactionToAskRequest(ask))
  else if (agent.pendingAskQuestion) {
    useAgentStore.setState({ pendingAskQuestion: null, isSubmittingAskQuestion: false, askQuestionError: null })
  }
}

function snapshotResolvesCancelling(state: RunViewState, snapshot: RunSnapshot): boolean {
  if (!isTerminalRunStatus(snapshot.status)) return false
  if (state.forceTerminateRunId) return state.forceTerminateRunId === snapshot.runId
  return snapshot.sessionId === (state.cancellingSessionId ?? state.selectedSessionId)
}

export const useRunStore = create<RunViewState>((set, get) => ({
  snapshot: null,
  lastSequence: 0,
  snapshotsByRunId: {},
  activeRunIdBySessionId: {},
  lastSequenceByRunId: {},
  selectedSessionId: null,
  pullTokenBySessionId: {},
  waitingSessions: [],
  cancelling: false,
  cancellingSessionId: null,
  cancelGraceExceeded: false,
  forceTerminateRunId: null,

  selectSession: sessionId => {
    const snapshot = selectSessionSnapshot(get(), sessionId)
    set({ selectedSessionId: sessionId, snapshot, lastSequence: snapshot?.sequence ?? 0 })
    if (!sessionId) useAgentStore.getState().resetAgentRuntime()
    else void get().refreshInteractionProjection()
  },

  pullSnapshot: sessionId => {
    const existing = pullInFlightBySession.get(sessionId)
    if (existing) return existing
    const token = (get().pullTokenBySessionId[sessionId] ?? 0) + 1
    const initialSnapshot = selectSessionSnapshot(get(), sessionId)
    set({ pullTokenBySessionId: { ...get().pullTokenBySessionId, [sessionId]: token } })
    let promise: Promise<void>
    promise = (async () => {
      try {
        const result = await window.api.invoke('run:get-snapshot', { sessionId })
        if (get().pullTokenBySessionId[sessionId] !== token) return
        const snapshot = result?.snapshot ?? null
        if (snapshot) {
          if (snapshot.sessionId !== sessionId) throw new Error('快照会话身份不匹配')
          get().handleSnapshotEvent(snapshot, { sequence: snapshot.sequence, type: 'snapshot_pull', at: Date.now() })
        } else if (selectSessionSnapshot(get(), sessionId) === initialSnapshot) {
          // 查询期间到达的新广播优先于较早读出的空结果。
          const activeRunIdBySessionId = { ...get().activeRunIdBySessionId }
          delete activeRunIdBySessionId[sessionId]
          set({
            activeRunIdBySessionId,
            ...(get().selectedSessionId === sessionId ? { snapshot: null, lastSequence: 0 } : {})
          })
        }
        if (result?.waitingSessions && !areWaitingSessionsEqual(get().waitingSessions, result.waitingSessions)) {
          set({ waitingSessions: result.waitingSessions })
        }
        await get().refreshInteractionProjection()
      } catch (err) {
        console.error('[useRunStore] pullSnapshot 失败:', err)
      }
    })().finally(() => {
      if (pullInFlightBySession.get(sessionId) === promise) pullInFlightBySession.delete(sessionId)
    })
    pullInFlightBySession.set(sessionId, promise)
    return promise
  },

  handleSnapshotEvent: (snapshot, event) => {
    if (!snapshot.runId || !snapshot.sessionId || !Number.isSafeInteger(snapshot.sequence) ||
        snapshot.sequence < 1 || snapshot.sequence !== event.sequence || !Array.isArray(snapshot.pendingInteractions)) {
      if (snapshot.sessionId && event.type !== 'snapshot_pull') void get().pullSnapshot(snapshot.sessionId)
      return
    }
    const state = get()
    const previous = state.snapshotsByRunId[snapshot.runId]
    if (snapshot.sequence <= (state.lastSequenceByRunId[snapshot.runId] ?? 0)) return
    if (previous && previous.sessionId !== snapshot.sessionId) return
    const active = selectSessionSnapshot(state, snapshot.sessionId)
    const isLatestRun = !active || active.runId === snapshot.runId || snapshot.createdAt >= active.createdAt
    const isSelected = isLatestRun && state.selectedSessionId === snapshot.sessionId
    set({
      snapshotsByRunId: { ...state.snapshotsByRunId, [snapshot.runId]: snapshot },
      activeRunIdBySessionId: isLatestRun
        ? { ...state.activeRunIdBySessionId, [snapshot.sessionId]: snapshot.runId }
        : state.activeRunIdBySessionId,
      lastSequenceByRunId: { ...state.lastSequenceByRunId, [snapshot.runId]: snapshot.sequence },
      ...(isSelected ? { snapshot, lastSequence: snapshot.sequence } : {})
    })
    if (get().cancelling && snapshotResolvesCancelling(get(), snapshot)) {
      clearCancelGraceTimer()
      set({ cancelling: false, cancellingSessionId: null, cancelGraceExceeded: false, forceTerminateRunId: null })
    }
    const enteredTerminal = isTerminalRunStatus(snapshot.status) && (!previous || !isTerminalRunStatus(previous.status))
    void (async () => {
      const { useChatStore } = await import('./useChatStore')
      const latest = selectSessionSnapshot(get(), snapshot.sessionId)
      const chat = useChatStore.getState()
      if (latest?.runId === snapshot.runId && chat.currentSessionId === snapshot.sessionId) {
        if (enteredTerminal && isTerminalRunStatus(latest.status)) {
          await chat.handleRunTerminal(snapshot)
        } else if (!isTerminalRunStatus(latest.status)) {
          chat.handleRunActive(latest)
        }
      }
    })().catch(err => console.error('[useRunStore] 终态展示对账失败:', err))
    void get().refreshInteractionProjection()
    if (getWaitingBadgeCountForSnapshot(previous ?? null) !== getWaitingBadgeCountForSnapshot(snapshot)) {
      void get().refreshWaitingBadges()
    }
  },

  refreshInteractionProjection: async () => {
    const { useChatStore } = await import('./useChatStore')
    const { isDescendantSessionOf } = await import('../lib/agentEventGate')
    const sessionId = get().selectedSessionId
    if (!sessionId || useChatStore.getState().currentSessionId !== sessionId) return
    const descendants = useChatStore.getState().sessions
      .filter(s => isDescendantSessionOf(s.id, sessionId))
      .flatMap(s => {
        const snapshot = selectSessionSnapshot(get(), s.id)
        return snapshot ? [snapshot] : []
      })
    projectInteractionsToAgentStore(selectSessionSnapshot(get(), sessionId), sessionId, descendants)
  },

  refreshWaitingBadges: async () => {
    const seq = ++refreshWaitingBadgesSeq
    try {
      const list = await window.api.invoke('run:list-waiting')
      if (seq === refreshWaitingBadgesSeq && Array.isArray(list) && !areWaitingSessionsEqual(get().waitingSessions, list)) {
        set({ waitingSessions: list })
      }
    } catch (err) {
      console.error('[useRunStore] 等待徽标刷新失败:', err)
    }
  },

  beginLocalCancel: runId => {
    const target = runId ?? null
    const snapshot = target ? get().snapshotsByRunId[target] : null
    if (snapshot && isTerminalRunStatus(snapshot.status)) return
    const cancellingSessionId = snapshot?.sessionId ??
      (get().cancelling ? get().cancellingSessionId : get().selectedSessionId)
    clearCancelGraceTimer()
    set({ cancelling: true, cancellingSessionId, cancelGraceExceeded: false, forceTerminateRunId: target })
    cancelGraceTimer = setTimeout(() => {
      cancelGraceTimer = null
      if (get().cancelling) set({ cancelGraceExceeded: true })
    }, CANCEL_GRACE_MS)
  },

  forceTerminate: async () => {
    const state = get()
    if (state.cancellingSessionId !== state.selectedSessionId) return
    const runId = state.forceTerminateRunId ?? state.snapshot?.runId
    if (!runId) return
    try {
      const result = await window.api.invoke('run:force-terminate', { runId })
      if (result.snapshot) get().handleSnapshotEvent(result.snapshot, {
        sequence: result.snapshot.sequence, type: 'force_terminate', at: Date.now()
      })
    } catch (err) {
      console.error('[useRunStore] forceTerminate 失败:', err)
    }
  },

  resetForTests: () => {
    clearCancelGraceTimer()
    pullInFlightBySession.clear()
    refreshWaitingBadgesSeq++
    set({
      snapshot: null, lastSequence: 0, snapshotsByRunId: {}, activeRunIdBySessionId: {},
      lastSequenceByRunId: {}, selectedSessionId: null, pullTokenBySessionId: {}, waitingSessions: [],
      cancelling: false, cancellingSessionId: null, cancelGraceExceeded: false, forceTerminateRunId: null
    })
  }
}))

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
