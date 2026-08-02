import type { RunCoordinator } from '../../../runtime/run'
import type { SessionStore } from '../../../runtime/sessions'
import type { InternalSessionSummary } from '../../../runtime/sessions/types'
import { projectSubagentExecutionResult } from '../../../runtime/subagents'
import { isTerminalRunStatus } from '../../../shared/run/types'
import type { SubagentActivityProjection } from '../../../shared/subagents'

export interface SubagentProjectionServiceDeps {
  readonly sessionStore: SessionStore
  readonly runCoordinator: RunCoordinator
}

/** 只读 join 服务：Child Session 与 RunSnapshot 仍由各自 Owner 持久化。 */
export class SubagentProjectionService {
  constructor(private readonly deps: SubagentProjectionServiceDeps) {}

  listByParentSessionId(parentSessionId: string): SubagentActivityProjection[] {
    return this.listFromSummaries(
      this.deps.sessionStore.listInternal(),
      new Set([parentSessionId]),
      true
    )
  }

  /** Renderer 首次水合只取轻投影：一次 metadata 扫描，不逐 child 读 transcript。 */
  listLightweightByParentSessionIds(
    parentSessionIds: readonly string[]
  ): SubagentActivityProjection[] {
    return this.listFromSummaries(
      this.deps.sessionStore.listInternal(),
      new Set(parentSessionIds),
      false
    )
  }

  private listFromSummaries(
    summaries: readonly InternalSessionSummary[],
    parentSessionIds: ReadonlySet<string>,
    includeTerminalDetails: boolean
  ): SubagentActivityProjection[] {
    return summaries
      .filter(
        (session): session is Extract<InternalSessionSummary, { kind: 'subagent' }> =>
          session.kind === 'subagent' &&
          parentSessionIds.has(session.subagent.lineage.parentSessionId)
      )
      .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
      .map((session) => this.project(session, includeTerminalDetails))
  }

  getByParentToolCallId(
    parentSessionId: string,
    parentToolCallId: string
  ): SubagentActivityProjection | null {
    const session = this.deps.sessionStore.listInternal().find(
      (candidate): candidate is Extract<InternalSessionSummary, { kind: 'subagent' }> =>
        candidate.kind === 'subagent' &&
        candidate.subagent.lineage.parentSessionId === parentSessionId &&
        candidate.subagent.lineage.origin.kind === 'task_tool' &&
        candidate.subagent.lineage.origin.parentToolCallId === parentToolCallId
    )
    return session ? this.project(session, true) : null
  }

  getByChildSessionId(childSessionId: string): SubagentActivityProjection | null {
    const session = this.deps.sessionStore
      .listInternal()
      .find((candidate) => candidate.id === childSessionId)
    return session?.kind === 'subagent' ? this.project(session, true) : null
  }

  private project(
    session: Extract<InternalSessionSummary, { kind: 'subagent' }>,
    includeTerminalDetails: boolean
  ): SubagentActivityProjection {
    const { lineage, profile } = session.subagent
    const snapshot = this.deps.runCoordinator.getSnapshot(lineage.spawnRunId)
    const base = {
      childSessionId: session.id,
      childRunId: lineage.spawnRunId,
      parentSessionId: lineage.parentSessionId,
      ...(lineage.origin.kind === 'task_tool'
        ? { parentToolCallId: lineage.origin.parentToolCallId }
        : {
            parentToolCallId: lineage.origin.parentToolCallId,
            workflow: {
              workflowRunId: lineage.origin.workflowRunId,
              phase: lineage.origin.phase,
              ...(lineage.origin.taskId ? { taskId: lineage.origin.taskId } : {}),
              ...(lineage.origin.batchId ? { batchId: lineage.origin.batchId } : {}),
              occurrence: lineage.origin.occurrence ?? 0
            }
          }),
      profile,
      taskLabel: session.title?.trim() || '未命名子任务',
      artifactCount: 0
    }

    if (!snapshot) {
      return { ...base, status: 'record_missing' }
    }

    const hasPendingInteraction = snapshot.pendingInteractions.some(
      (interaction) => interaction.status === 'pending' || interaction.status === 'submitting'
    )
    if (hasPendingInteraction) {
      return {
        ...base,
        status: 'waiting_user',
        sequence: snapshot.sequence,
        startedAt: snapshot.turnStartedAt ?? snapshot.createdAt,
        latestActivity: '等待你的授权'
      }
    }

    if (!isTerminalRunStatus(snapshot.status)) {
      return {
        ...base,
        status: snapshot.status,
        sequence: snapshot.sequence,
        startedAt: snapshot.turnStartedAt ?? snapshot.createdAt,
        latestActivity: snapshot.progress?.label
      }
    }

    if (!includeTerminalDetails) {
      return {
        ...base,
        status: snapshot.status,
        sequence: snapshot.sequence,
        startedAt: snapshot.turnStartedAt ?? snapshot.createdAt,
        completedAt: snapshot.updatedAt,
        latestActivity: snapshot.progress?.label
      }
    }

    const childSession = this.deps.sessionStore.load(session.id)
    if (!childSession || childSession.kind !== 'subagent') {
      return {
        ...base,
        status: 'record_missing',
        sequence: snapshot.sequence,
        startedAt: snapshot.turnStartedAt ?? snapshot.createdAt,
        completedAt: snapshot.updatedAt
      }
    }
    const result = projectSubagentExecutionResult({ childSession, runSnapshot: snapshot })
    return {
      ...base,
      status: snapshot.status,
      sequence: snapshot.sequence,
      startedAt: result.startedAt,
      completedAt: result.completedAt,
      latestActivity: snapshot.progress?.label,
      summary: result.summary,
      artifactCount: result.artifactIds.length,
      ...(result.failure ? { failure: result.failure } : {})
    }
  }
}
