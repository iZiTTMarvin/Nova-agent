import { create } from 'zustand'
import type { RunSnapshot } from '../../../shared/run/types'
import type { Session, SessionDetail } from '../../../shared/session/types'
import type { SubagentActivityProjection } from '../../../shared/subagents'

export interface SubagentProjectionState {
  byChildSessionId: Record<string, SubagentActivityProjection>
  childIdsByParentSessionId: Record<string, string[]>
  childSessionIdByParentToolCallId: Record<string, string>
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
  byChildSessionId: {},
  childIdsByParentSessionId: {},
  childSessionIdByParentToolCallId: {}
}

const refreshTokens = new Map<string, number>()
let summaryRefreshToken = 0

function indexProjections(
  projections: Iterable<SubagentActivityProjection>
): SubagentProjectionState {
  const byChildSessionId: Record<string, SubagentActivityProjection> = {}
  const childIdsByParentSessionId: Record<string, string[]> = {}
  const childSessionIdByParentToolCallId: Record<string, string> = {}
  for (const projection of projections) {
    byChildSessionId[projection.childSessionId] = projection
    const children = childIdsByParentSessionId[projection.parentSessionId] ?? []
    children.push(projection.childSessionId)
    childIdsByParentSessionId[projection.parentSessionId] = children
    if (projection.parentToolCallId) {
      childSessionIdByParentToolCallId[projection.parentToolCallId] = projection.childSessionId
    }
  }
  return { byChildSessionId, childIdsByParentSessionId, childSessionIdByParentToolCallId }
}

function replaceParent(
  state: SubagentProjectionState,
  parentSessionId: string,
  projections: SubagentActivityProjection[]
): SubagentProjectionState {
  const retained = Object.values(state.byChildSessionId).filter(
    (projection) => projection.parentSessionId !== parentSessionId
  )
  const reconciled = projections.map((projection) => {
    const current = state.byChildSessionId[projection.childSessionId]
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
    const previous = get().byChildSessionId
    const subagentSessions = sessions.filter(
      (session): session is Extract<Session, { kind: 'subagent' }> => session.kind === 'subagent'
    )
    const durableChildIds = new Set(subagentSessions.map((session) => session.id))
    set(indexProjections(
      Object.values(previous).filter((projection) => durableChildIds.has(projection.childSessionId))
    ))

    const parentsNeedingRefresh = new Set(
      subagentSessions
        .filter((session) => previous[session.id] === undefined)
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
    const projection = get().byChildSessionId[snapshot.sessionId]
    if (!projection || projection.childRunId !== snapshot.runId) return
    if (projection.sequence !== undefined && snapshot.sequence <= projection.sequence) return
    set((state) => ({
      ...state,
      byChildSessionId: {
        ...state.byChildSessionId,
        [projection.childSessionId]: {
          ...projection,
          status: snapshot.status,
          sequence: snapshot.sequence,
          startedAt: snapshot.turnStartedAt ?? snapshot.createdAt,
          completedAt:
            snapshot.status === 'completed' ||
            snapshot.status === 'failed' ||
            snapshot.status === 'cancelled' ||
            snapshot.status === 'interrupted'
              ? snapshot.updatedAt
              : undefined,
          latestActivity: snapshot.progress?.label
        }
      }
    }))
    if (
      snapshot.status === 'completed' ||
      snapshot.status === 'failed' ||
      snapshot.status === 'cancelled' ||
      snapshot.status === 'interrupted'
    ) {
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
      const current = Object.values(get().byChildSessionId).filter(
        (item) =>
          item.parentSessionId === parentSessionId &&
          item.childSessionId !== projection.childSessionId
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
  const childSessionId = state.childSessionIdByParentToolCallId[parentToolCallId]
  return childSessionId ? state.byChildSessionId[childSessionId] : undefined
}
