import type { RunCoordinator } from '../../../runtime/run'
import type { SessionStore } from '../../../runtime/sessions'
import { generateSessionTitleFromText } from '../../../runtime/sessions/types'
import type { InternalSessionSummary } from '../../../runtime/sessions/types'
import {
  createFollowupSpawnIdentity,
  projectSubagentExecutionResult
} from '../../../runtime/subagents'
import { parseFollowupArguments } from '../../../runtime/tools/task_followup'
import { buildSessionDiffState } from '../../../runtime/checkpoints/sessionDiffState'
import { countEntryChanges } from '../../../shared/diff/compute'
import { isTerminalRunStatus, type RunSnapshot } from '../../../shared/run/types'
import type {
  SubagentActivityProjection,
  SubagentFileChange,
  SubagentModelSnapshot
} from '../../../shared/subagents'

export interface SubagentProjectionServiceDeps {
  readonly sessionStore: SessionStore
  readonly runCoordinator: RunCoordinator
}

type SubagentSummary = Extract<InternalSessionSummary, { kind: 'subagent' }>

/** followup run 的父调用归属：由父会话正向重算 spawnRunId 后对齐得到。 */
interface FollowupAttribution {
  readonly parentToolCallId: string
  readonly taskLabel: string
  readonly childSessionId: string
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
    // 一次投影请求内共享的 followup 归属索引（parentSessionId → index），请求结束即丢弃
    const followupIndexes = new Map<string, Map<string, FollowupAttribution>>()
    return summaries
      .filter(
        (session): session is SubagentSummary =>
          session.kind === 'subagent' &&
          parentSessionIds.has(session.subagent.lineage.parentSessionId)
      )
      .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
      .flatMap((session) =>
        this.projectRuns(session, includeTerminalDetails, followupIndexes)
      )
  }

  getByParentToolCallId(
    parentSessionId: string,
    parentToolCallId: string
  ): SubagentActivityProjection | null {
    const summaries = this.deps.sessionStore.listInternal()
    // 出生 run 的父调用身份由 lineage.origin 直接持久化，无需重算
    const birth = summaries.find(
      (candidate): candidate is SubagentSummary =>
        candidate.kind === 'subagent' &&
        candidate.subagent.lineage.parentSessionId === parentSessionId &&
        candidate.subagent.lineage.origin.kind === 'task_tool' &&
        candidate.subagent.lineage.origin.parentToolCallId === parentToolCallId
    )
    if (birth) {
      return (
        this.projectRuns(birth, true).find(
          (projection) => projection.childRunId === birth.subagent.lineage.spawnRunId
        ) ?? null
      )
    }
    for (const [spawnRunId, attribution] of this.buildFollowupIndex(parentSessionId)) {
      if (attribution.parentToolCallId !== parentToolCallId) continue
      const session = summaries.find(
        (candidate): candidate is SubagentSummary =>
          candidate.kind === 'subagent' && candidate.id === attribution.childSessionId
      )
      if (!session) return null
      return (
        this.projectRuns(session, true).find(
          (projection) => projection.childRunId === spawnRunId
        ) ?? null
      )
    }
    return null
  }

  getByChildSessionId(childSessionId: string): SubagentActivityProjection | null {
    const session = this.deps.sessionStore
      .listInternal()
      .find((candidate) => candidate.id === childSessionId)
    if (session?.kind !== 'subagent') return null
    const projections = this.projectRuns(session, true)
    return projections[projections.length - 1] ?? null
  }

  /**
   * 一个子会话的每个 run 各产出一条投影（出生 run 在前、followup run 按 createdAt 升序）。
   * runs 为空时退回 lineage.spawnRunId 单条投影（可能 record_missing）。
   */
  private projectRuns(
    session: SubagentSummary,
    includeTerminalDetails: boolean,
    followupIndexes?: Map<string, Map<string, FollowupAttribution>>
  ): SubagentActivityProjection[] {
    const { lineage } = session.subagent
    const runs = this.deps.runCoordinator.listSnapshotsForSession(session.id)
    if (runs.length === 0) {
      const snapshot = this.deps.runCoordinator.getSnapshot(lineage.spawnRunId)
      return [
        this.projectRun(session, snapshot, {
          isBirth: true,
          includeTerminalDetails,
          withFileChanges:
            includeTerminalDetails && snapshot !== null && isTerminalRunStatus(snapshot.status)
        })
      ]
    }
    // 只有存在出生之外的 run 才需要正向归属；单 run 子会话不触发父会话扫描
    const followupIndex = runs.every((run) => run.runId === lineage.spawnRunId)
      ? undefined
      : this.getFollowupIndex(lineage.parentSessionId, followupIndexes)
    const lastRunId = runs[runs.length - 1]!.runId
    return runs.map((snapshot) => {
      const isBirth = snapshot.runId === lineage.spawnRunId
      const attribution = !isBirth ? followupIndex?.get(snapshot.runId) : undefined
      return this.projectRun(session, snapshot, {
        isBirth,
        ...(attribution
          ? { parentToolCallId: attribution.parentToolCallId, taskLabel: attribution.taskLabel }
          : {}),
        includeTerminalDetails,
        // 会话级 diff 是聚合值，只挂最后一个终态 run，避免多行重复展示同一份改动
        withFileChanges:
          includeTerminalDetails &&
          snapshot.runId === lastRunId &&
          isTerminalRunStatus(snapshot.status)
      })
    })
  }

  private projectRun(
    session: SubagentSummary,
    snapshot: RunSnapshot | null,
    options: {
      readonly isBirth: boolean
      readonly parentToolCallId?: string
      readonly taskLabel?: string
      readonly includeTerminalDetails: boolean
      readonly withFileChanges: boolean
    }
  ): SubagentActivityProjection {
    const { lineage } = session.subagent
    const { model: _profileModel, ...profileProjection } = session.subagent.profile
    const header = session.subagent.header
    const effectiveModel: SubagentModelSnapshot | undefined = header
      ? { providerId: header.providerId, modelId: header.modelId }
      : undefined
    // 出生 run 沿用 lineage.origin（含 workflow 溯源字段）；followup run 用正向重算的父调用身份
    const parentIdentity = options.isBirth
      ? lineage.origin.kind === 'workflow'
        ? {
            parentToolCallId: lineage.origin.parentToolCallId,
            workflow: {
              workflowRunId: lineage.origin.workflowRunId,
              phase: lineage.origin.phase,
              ...(lineage.origin.taskId ? { taskId: lineage.origin.taskId } : {}),
              ...(lineage.origin.batchId ? { batchId: lineage.origin.batchId } : {}),
              occurrence: lineage.origin.occurrence ?? 0
            }
          }
        : lineage.origin.parentToolCallId
          ? { parentToolCallId: lineage.origin.parentToolCallId }
          : {}
      : options.parentToolCallId
        ? { parentToolCallId: options.parentToolCallId }
        : {}
    const base = {
      childSessionId: session.id,
      childRunId: snapshot?.runId ?? lineage.spawnRunId,
      parentSessionId: lineage.parentSessionId,
      ...parentIdentity,
      profile: profileProjection,
      taskLabel: options.taskLabel?.trim() || session.title?.trim() || '未命名子任务',
      artifactCount: 0,
      ...(effectiveModel ? { model: effectiveModel } : {}),
      ...(header ? { reasoningEffort: header.reasoningEffort } : {})
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

    if (!options.includeTerminalDetails) {
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
    const fileChanges = options.withFileChanges ? this.buildFileChanges(session) : []
    return {
      ...base,
      status: snapshot.status,
      sequence: snapshot.sequence,
      startedAt: result.startedAt,
      completedAt: result.completedAt,
      latestActivity: snapshot.progress?.label,
      summary: result.summary,
      artifactCount: result.artifactIds.length,
      ...(result.failure ? { failure: result.failure } : {}),
      ...(fileChanges.length > 0 ? { fileChanges } : {})
    }
  }

  /** 终态才计算会话级聚合 diff；只读子代理无 checkpoint，天然返回空数组。 */
  private buildFileChanges(
    session: SubagentSummary
  ): SubagentFileChange[] {
    const state = buildSessionDiffState(
      this.deps.sessionStore.getSessionsDir(),
      session.workspaceRoot,
      session.id
    )
    return state.diffs
      .filter((entry) => entry.hunks.length > 0)
      .map((entry) => {
        const { additions, deletions } = countEntryChanges(entry)
        return {
          filePath: entry.filePath,
          status: entry.status,
          addedLines: additions,
          removedLines: deletions
        }
      })
  }

  /** 请求内缓存：同一父会话的多个子会话共享一次扫描。 */
  private getFollowupIndex(
    parentSessionId: string,
    cache?: Map<string, Map<string, FollowupAttribution>>
  ): Map<string, FollowupAttribution> {
    const cached = cache?.get(parentSessionId)
    if (cached) return cached
    const index = this.buildFollowupIndex(parentSessionId)
    cache?.set(parentSessionId, index)
    return index
  }

  /**
   * followup run 的父调用身份只能正向重算：spawnRunId 由触发字段单向 hash 派生，无法反推。
   * 父 run 的 toolCommits 提供「工具调用 → run」映射（run.messageId 会被后续消息覆盖，不可用），
   * 父会话消息的 toolCalls 提供参数与消息归属；hash 复用执行层导出的同一纯函数。
   */
  private buildFollowupIndex(
    parentSessionId: string
  ): Map<string, FollowupAttribution> {
    const index = new Map<string, FollowupAttribution>()
    const parentRunIdByToolCallId = new Map<string, string>()
    for (const run of this.deps.runCoordinator.listSnapshotsForSession(parentSessionId)) {
      for (const commit of run.toolCommits ?? []) {
        if (commit.toolName === 'task_followup') {
          parentRunIdByToolCallId.set(commit.toolCallId, run.runId)
        }
      }
    }
    const parentSession = this.deps.sessionStore.load(parentSessionId)
    if (!parentSession) return index
    for (const message of parentSession.messages) {
      for (const call of message.toolCalls ?? []) {
        if (call.name !== 'task_followup') continue
        const parentRunId = parentRunIdByToolCallId.get(call.id)
        if (!parentRunId) continue
        const args = parseFollowupArguments(call.arguments)
        if (!args) continue
        const identity = createFollowupSpawnIdentity({
          parentSessionId,
          parentRunId,
          previousChildSessionId: args.childSessionId,
          parentMessageId: message.id,
          parentToolCallId: call.id,
          task: args.task
        })
        index.set(identity.spawnRunId, {
          parentToolCallId: call.id,
          taskLabel: generateSessionTitleFromText(args.task),
          childSessionId: args.childSessionId
        })
      }
    }
    return index
  }
}
