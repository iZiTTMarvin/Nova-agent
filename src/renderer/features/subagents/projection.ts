import { create } from 'zustand'
import type { RunSnapshot } from '../../../shared/run/types'
import type { Session, SessionDetail } from '../../../shared/session/types'
import type { SubagentActivityProjection } from '../../../shared/subagents'

export interface SubagentProjectionState {
  byChildRunId: Record<string, SubagentActivityProjection>
  childRunIdsByParentSessionId: Record<string, string[]>
  childRunIdByParentToolCallId: Record<string, string>
}

interface SubagentProjectionActions {
  /** Session list 只提供 durable lineage；已知 projection 会被保留。 */
  syncSessionList: (sessions: Session[]) => void
  /** Session detail / projection IPC 的权威 join 结果。 */
  hydrateParent: (parentSessionId: string, projections: SubagentActivityProjection[]) => void
  hydrateSessionDetail: (detail: SessionDetail) => void
  /** 带 sequence 的 RunSnapshot 只能更新对应 child run。 */
  applyRunSnapshot: (snapshot: RunSnapshot) => void
  refreshParents: (parentSessionIds: readonly string[]) => Promise<void>
  refreshParent: (parentSessionId: string) => Promise<void>
  refreshTool: (parentSessionId: string, parentToolCallId: string) => Promise<void>
  resetForTests: () => void
}

export type SubagentProjectionStore = SubagentProjectionState & SubagentProjectionActions

const EMPTY_STATE: SubagentProjectionState = {
  byChildRunId: {},
  childRunIdsByParentSessionId: {},
  childRunIdByParentToolCallId: {}
}

const refreshTokens = new Map<string, number>()
let summaryRefreshToken = 0

function indexProjections(
  projections: Iterable<SubagentActivityProjection>
): SubagentProjectionState {
  const byChildRunId: Record<string, SubagentActivityProjection> = {}
  const childRunIdsByParentSessionId: Record<string, string[]> = {}
  const childRunIdByParentToolCallId: Record<string, string> = {}
  for (const projection of projections) {
    byChildRunId[projection.childRunId] = projection
    const runs = childRunIdsByParentSessionId[projection.parentSessionId] ?? []
    runs.push(projection.childRunId)
    childRunIdsByParentSessionId[projection.parentSessionId] = runs
    if (projection.parentToolCallId) {
      childRunIdByParentToolCallId[projection.parentToolCallId] = projection.childRunId
    }
  }
  return { byChildRunId, childRunIdsByParentSessionId, childRunIdByParentToolCallId }
}

function replaceParent(
  state: SubagentProjectionState,
  parentSessionId: string,
  projections: SubagentActivityProjection[]
): SubagentProjectionState {
  const retained = Object.values(state.byChildRunId).filter(
    (projection) => projection.parentSessionId !== parentSessionId
  )
  const reconciled = projections.map((projection) => {
    const current = state.byChildRunId[projection.childRunId]
    if (
      current?.sequence !== undefined &&
      (projection.sequence === undefined || current.sequence > projection.sequence)
    ) {
      return current
    }
    if (
      current?.sequence !== undefined &&
      current.sequence === projection.sequence &&
      (current.summary !== undefined || current.failure !== undefined || current.artifactCount > 0) &&
      projection.summary === undefined &&
      projection.failure === undefined &&
      projection.artifactCount === 0
    ) {
      return current
    }
    return projection
  })
  return indexProjections([...retained, ...reconciled])
}

export const useSubagentProjectionStore = create<SubagentProjectionStore>((set, get) => ({
  ...EMPTY_STATE,

  syncSessionList: (sessions) => {
    const previous = get().byChildRunId
    const subagentSessions = sessions.filter(
      (session): session is Extract<Session, { kind: 'subagent' }> => session.kind === 'subagent'
    )
    const durableChildIds = new Set(subagentSessions.map((session) => session.id))
    set(indexProjections(
      Object.values(previous).filter((projection) => durableChildIds.has(projection.childSessionId))
    ))

    const knownChildIds = new Set(
      Object.values(previous).map((projection) => projection.childSessionId)
    )
    const parentsNeedingRefresh = new Set(
      subagentSessions
        .filter((session) => !knownChildIds.has(session.id))
        .map((session) => session.subagent.lineage.parentSessionId)
    )
    if (parentsNeedingRefresh.size > 0) {
      void get().refreshParents([...parentsNeedingRefresh])
    }
  },

  hydrateParent: (parentSessionId, projections) => {
    set((state) => replaceParent(state, parentSessionId, projections))
  },

  hydrateSessionDetail: (detail) => {
    get().hydrateParent(detail.id, detail.subagentProjections ?? [])
  },

  applyRunSnapshot: (snapshot) => {
    // childRunId 严格匹配：一个子会话可有多个 run，各 run 的投影互不覆盖
    const projection = get().byChildRunId[snapshot.runId]
    const isTerminal =
      snapshot.status === 'completed' ||
      snapshot.status === 'failed' ||
      snapshot.status === 'cancelled' ||
      snapshot.status === 'interrupted'
    if (!projection) {
      // followup 的父调用归属靠父会话工具调用正向重算，而该消息要等父 turn 结束才落盘；
      // 父 run 终态后补一次刷新，让 followup 活动行补齐归属（消息持久化先于 run 终态提交）
      if (isTerminal && get().childRunIdsByParentSessionId[snapshot.sessionId] !== undefined) {
        void get().refreshParent(snapshot.sessionId)
      }
      return
    }
    if (projection.sequence !== undefined && snapshot.sequence <= projection.sequence) return
    set((state) => ({
      ...state,
      byChildRunId: {
        ...state.byChildRunId,
        [snapshot.runId]: {
          ...projection,
          status: snapshot.status,
          sequence: snapshot.sequence,
          startedAt: snapshot.turnStartedAt ?? snapshot.createdAt,
          completedAt: isTerminal ? snapshot.updatedAt : undefined,
          latestActivity: snapshot.progress?.label
        }
      }
    }))
    if (isTerminal) {
      void get().refreshParent(projection.parentSessionId)
    }
  },

  refreshParents: async (parentSessionIds) => {
    const uniqueParentIds = [...new Set(parentSessionIds)]
    if (uniqueParentIds.length === 0) return
    const token = ++summaryRefreshToken
    try {
      const projections = await window.api.invoke('subagent:list-projection-summaries', {
        parentSessionIds: uniqueParentIds
      })
      if (summaryRefreshToken !== token) return
      set((state) => {
        let next: SubagentProjectionState = state
        for (const parentSessionId of uniqueParentIds) {
          next = replaceParent(
            next,
            parentSessionId,
            projections.filter((projection) => projection.parentSessionId === parentSessionId)
          )
        }
        return next
      })
    } catch (error) {
      console.error('[subagent projection] 批量刷新投影失败:', error)
    }
  },

  refreshParent: async (parentSessionId) => {
    const token = (refreshTokens.get(parentSessionId) ?? 0) + 1
    refreshTokens.set(parentSessionId, token)
    try {
      const projections = await window.api.invoke('subagent:list-projections', {
        parentSessionId
      })
      if (refreshTokens.get(parentSessionId) !== token) return
      get().hydrateParent(parentSessionId, projections)
    } catch (error) {
      console.error('[subagent projection] 刷新父会话投影失败:', error)
    }
  },

  refreshTool: async (parentSessionId, parentToolCallId) => {
    try {
      const projection = await window.api.invoke('subagent:get-projection', {
        parentSessionId,
        parentToolCallId
      })
      if (!projection) return
      const current = Object.values(get().byChildRunId).filter(
        (item) =>
          item.parentSessionId === parentSessionId &&
          item.childRunId !== projection.childRunId
      )
      get().hydrateParent(parentSessionId, [...current, projection])
    } catch (error) {
      console.error('[subagent projection] 刷新工具投影失败:', error)
    }
  },

  resetForTests: () => {
    refreshTokens.clear()
    summaryRefreshToken = 0
    set(EMPTY_STATE)
  }
}))

export function selectSubagentByParentToolCallId(
  state: SubagentProjectionState,
  parentToolCallId: string
): SubagentActivityProjection | undefined {
  const childRunId = state.childRunIdByParentToolCallId[parentToolCallId]
  return childRunId ? state.byChildRunId[childRunId] : undefined
}

/** 同一子会话多 run 时取最新一条（run 的 startedAt 单调递增；单 run 直接返回）。 */
export function selectLatestSubagentByChildSessionId(
  state: SubagentProjectionState,
  childSessionId: string
): SubagentActivityProjection | undefined {
  const candidates = Object.values(state.byChildRunId).filter(
    (projection) => projection.childSessionId === childSessionId
  )
  if (candidates.length <= 1) return candidates[0]
  return candidates.reduce((latest, candidate) =>
    (candidate.startedAt ?? 0) >= (latest.startedAt ?? 0) ? candidate : latest
  )
}
