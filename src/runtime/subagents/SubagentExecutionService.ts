import { createHash } from 'crypto'
import * as path from 'path'
import { isDeepStrictEqual } from 'util'
import type { AgentEvent, AgentLoop, EventBus } from '../agent'
import {
  AgentTurnExecutor,
  agentRoute,
  projectAgentEventToRun,
  type AgentTurnRunRefs
} from '../agent/turn'
import type { RunCoordinator } from '../run/RunCoordinator'
import {
  deriveChildSessionId,
  type SessionStore
} from '../sessions/SessionStore'
import type { SessionData, SubagentSessionData } from '../sessions/types'
import type {
  SpawnSubagentCommand,
  SubagentExecutionResult,
  SubagentFailureCode,
  SubagentLineage,
  SubagentOrigin,
  SubagentProfileSnapshot
} from '../../shared/subagents'
import { isTerminalRunStatus, type RunSnapshot } from '../../shared/run/types'
import type { ToolInvocationRef } from '../tools/types'
import type { Mode } from '../../shared/session'
import type { SpawnSubagentContext, SpawnSubagentPort } from './ports'
import { resolveSubagentProfileSnapshot } from './profileResolver'
import { projectSubagentExecutionResult } from './resultProjection'

export interface PrepareSubagentTurnInput {
  readonly profile: SubagentProfileSnapshot
  readonly task: string
  readonly workingDirectory: string
  readonly isolation: SpawnSubagentCommand['isolation']
  readonly invocationRef?: ToolInvocationRef
  readonly childSession: SubagentSessionData
  readonly parentRunId: string
  readonly rootRunId: string
}

export interface PreparedSubagentTurn {
  readonly agentLoop: AgentLoop
  readonly eventBus: EventBus
}

export interface SubagentEventContext extends AgentTurnRunRefs {
  readonly parentRunId: string
  readonly childSessionId: string
  readonly mode: Mode
  readonly workspaceRoot: string
  readonly agentLoop: AgentLoop
}

export interface SubagentExecutionLifecycleContext extends SubagentEventContext {}

export interface SubagentExecutionServiceDeps {
  readonly sessionStore: SessionStore
  readonly runCoordinator: RunCoordinator
  readonly turnExecutor: AgentTurnExecutor
  readonly loadProfile: (profileId: string) => unknown
  readonly prepareTurn: (input: PrepareSubagentTurnInput) => PreparedSubagentTurn
  readonly adaptEvent?: (event: AgentEvent, context: SubagentEventContext) => AgentEvent
  readonly onEvent?: (event: AgentEvent, context: SubagentEventContext) => void
  readonly onExecutionStarted?: (context: SubagentExecutionLifecycleContext) => void
  readonly onExecutionSettled?: (context: SubagentExecutionLifecycleContext) => void
  readonly maxDepth?: number
}

interface SpawnIdentity {
  spawnKey: string
  spawnRunId: string
}

interface ActiveSubagentExecution {
  readonly command: SpawnSubagentCommand
  readonly promise: Promise<SubagentExecutionResult>
}

/**
 * Child Session spawn 的唯一应用服务：校验 lineage、冻结 profile、幂等建会话并执行普通 turn。
 * Run 状态和消息正文仍分别由 RunCoordinator 与 SessionStore 拥有。
 */
export class SubagentExecutionService implements SpawnSubagentPort {
  private readonly activeExecutions = new Map<string, ActiveSubagentExecution>()
  private readonly maxDepth: number

  constructor(private readonly deps: SubagentExecutionServiceDeps) {
    this.maxDepth = deps.maxDepth ?? 2
  }

  spawn(
    command: SpawnSubagentCommand,
    context: SpawnSubagentContext = {}
  ): Promise<SubagentExecutionResult> {
    let identity: SpawnIdentity
    try {
      assertInvocationIdentity(command, context)
      identity = createSpawnIdentity(command)
    } catch (error) {
      return Promise.reject(error)
    }
    const active = this.activeExecutions.get(identity.spawnKey)
    if (active) {
      if (!isDeepStrictEqual(active.command, command)) {
        return Promise.reject(
          new Error(`spawnKey ${identity.spawnKey} 的并发命令 metadata 冲突`)
        )
      }
      return active.promise
    }

    const execution = this.spawnOnce(command, context, identity)
    this.activeExecutions.set(identity.spawnKey, { command, promise: execution })
    void execution.finally(() => {
      if (this.activeExecutions.get(identity.spawnKey)?.promise === execution) {
        this.activeExecutions.delete(identity.spawnKey)
      }
    }).catch(() => undefined)
    return execution
  }

  private async spawnOnce(
    command: SpawnSubagentCommand,
    context: SpawnSubagentContext,
    identity: SpawnIdentity
  ): Promise<SubagentExecutionResult> {
    const parentSession = this.deps.sessionStore.load(command.parentSessionId)
    if (!parentSession) {
      throw new Error(`父会话 ${command.parentSessionId} 不存在`)
    }
    this.requireParentRun(command)
    const lineageBase = resolveLineageBase(parentSession, command.parentRunId)
    if (lineageBase.depth > this.maxDepth) {
      throw new Error(`子代理深度 ${lineageBase.depth} 超过上限 ${this.maxDepth}`)
    }
    validateWorkingDirectory(command, parentSession.workspaceRoot)

    const existingChild = this.deps.sessionStore.load(
      deriveChildSessionId(identity.spawnKey)
    )
    let profile: SubagentProfileSnapshot
    if (existingChild) {
      if (existingChild.kind !== 'subagent') {
        throw new Error(`spawnKey ${identity.spawnKey} 已绑定非 Child Session`)
      }
      if (existingChild.subagent.profile.profileId !== command.profileId) {
        throw new Error(`spawnKey ${identity.spawnKey} 的 profile identity 冲突`)
      }
      profile = existingChild.subagent.profile
    } else {
      const rawProfile = this.deps.loadProfile(command.profileId)
      if (rawProfile === undefined || rawProfile === null) {
        throw new Error(`未知子代理类型: ${command.profileId}`)
      }
      profile = resolveSubagentProfileSnapshot(rawProfile, command.profileId)
    }
    if (
      parentSession.kind === 'subagent' &&
      parentSession.subagent.profile.permissionCeiling === 'read_only' &&
      profile.permissionCeiling === 'workspace_write'
    ) {
      throw new Error('read_only 父子代理不能派生 workspace_write 子代理')
    }
    const lineage: SubagentLineage = {
      parentSessionId: command.parentSessionId,
      parentRunId: command.parentRunId,
      rootRunId: lineageBase.rootRunId,
      depth: lineageBase.depth,
      spawnKey: identity.spawnKey,
      spawnRunId: identity.spawnRunId,
      origin: command.invocation
    }
    const childResult = this.deps.sessionStore.createChildIfAbsent({
      workspaceRoot: command.workingDirectory,
      mode:
        profile.permissionCeiling === 'read_only' || command.isolation === 'readonly'
          ? 'plan'
          : 'default',
      task: command.task,
      subagent: { lineage, profile }
    })
    const childSession = childResult.session

    const existingRun = this.deps.runCoordinator.getSnapshot(identity.spawnRunId)
    if (existingRun) {
      assertChildRunIdentity(existingRun, childSession)
      if (!isTerminalRunStatus(existingRun.status)) {
        this.deps.runCoordinator.commitTerminal({
          runId: existingRun.runId,
          status: 'interrupted',
          reason: 'child run 缺少当前进程执行句柄'
        })
      }
      return this.projectResult(childSession, identity.spawnRunId)
    }

    const rootRun = this.deps.runCoordinator.getSnapshot(lineage.rootRunId)
    if (
      !rootRun ||
      rootRun.executionGeneration === undefined ||
      !this.deps.runCoordinator.isExecutionCurrent(
        lineage.rootRunId,
        rootRun.executionGeneration
      )
    ) {
      throw new Error(`root run ${lineage.rootRunId} 的 execution generation 不可用`)
    }

    if (context.abortSignal?.aborted) {
      this.commitWithoutExecution(
        childSession,
        identity.spawnRunId,
        'cancelled',
        '父执行已取消'
      )
      return this.projectResult(childSession, identity.spawnRunId)
    }

    let prepared: PreparedSubagentTurn
    try {
      prepared = this.deps.prepareTurn({
        profile,
        task: command.task,
        workingDirectory: command.workingDirectory,
        isolation: command.isolation,
        ...(context.invocationRef ? { invocationRef: context.invocationRef } : {}),
        childSession,
        parentRunId: command.parentRunId,
        rootRunId: lineage.rootRunId
      })
    } catch (error) {
      this.commitWithoutExecution(
        childSession,
        identity.spawnRunId,
        'failed',
        error instanceof Error ? error.message : String(error)
      )
      return this.projectResult(childSession, identity.spawnRunId, 'host')
    }

    const runRefs: AgentTurnRunRefs = {
      runId: identity.spawnRunId,
      resourceOwnerRunId: lineage.rootRunId,
      executionGeneration: 0
    }
    const eventContext = (): SubagentEventContext => ({
      ...runRefs,
      parentRunId: command.parentRunId,
      childSessionId: childSession.id,
      mode: childSession.mode,
      workspaceRoot: childSession.workspaceRoot,
      agentLoop: prepared.agentLoop
    })
    const unsubscribe = prepared.eventBus.on((event) => {
      const currentContext = eventContext()
      const adapted = this.deps.adaptEvent?.(event, currentContext) ?? event
      projectAgentEventToRun(
        {
          runCoordinator: this.deps.runCoordinator,
          runId: currentContext.runId,
          resourceOwnerRunId: currentContext.resourceOwnerRunId,
          sessionId: currentContext.childSessionId
        },
        adapted
      )
      this.deps.runCoordinator.touchHeartbeat(currentContext.runId)
      this.deps.onEvent?.(adapted, currentContext)
    })
    const cancelChild = (): void => prepared.agentLoop.cancel()
    context.abortSignal?.addEventListener('abort', cancelChild, { once: true })

    try {
      await this.deps.turnExecutor.execute({
        agentLoop: prepared.agentLoop,
        task: command.task,
        route: agentRoute(),
        sessionId: childSession.id,
        workingDirectory: command.workingDirectory,
        isolation: command.isolation,
        ...(context.invocationRef ? { invocationRef: context.invocationRef } : {}),
        profile,
        runId: identity.spawnRunId,
        resourceOwnerRunId: lineage.rootRunId,
        resourceOwnerGeneration: rootRun.executionGeneration,
        runRefs,
        onStarted: () => this.deps.onExecutionStarted?.(eventContext()),
        onCleanup: () => this.deps.onExecutionSettled?.(eventContext())
      })
    } catch {
      return this.projectResult(childSession, identity.spawnRunId, 'host')
    } finally {
      context.abortSignal?.removeEventListener('abort', cancelChild)
      unsubscribe()
      prepared.agentLoop.dispose()
    }

    return this.projectResult(childSession, identity.spawnRunId)
  }

  private requireParentRun(command: SpawnSubagentCommand): void {
    const parentRun = this.deps.runCoordinator.getSnapshot(command.parentRunId)
    if (!parentRun || parentRun.sessionId !== command.parentSessionId) {
      throw new Error('parent session/run identity 不匹配')
    }
    if (isTerminalRunStatus(parentRun.status)) {
      throw new Error(`parent run ${command.parentRunId} 已终止`)
    }
  }

  private commitWithoutExecution(
    childSession: SubagentSessionData,
    runId: string,
    status: 'failed' | 'cancelled' | 'interrupted',
    reason: string
  ): void {
    const snapshot = this.deps.runCoordinator.startRun({
      kind: 'agent',
      runId,
      workspaceId: childSession.workspaceRoot,
      sessionId: childSession.id
    })
    assertChildRunIdentity(snapshot, childSession)
    if (!isTerminalRunStatus(snapshot.status)) {
      if (snapshot.status !== 'running') this.deps.runCoordinator.markRunning(runId)
      this.deps.runCoordinator.commitTerminal({ runId, status, reason })
    }
  }

  private projectResult(
    childSession: SubagentSessionData,
    runId: string,
    failureCode?: SubagentFailureCode
  ): SubagentExecutionResult {
    const snapshot = this.deps.runCoordinator.getSnapshot(runId)
    if (!snapshot) throw new Error(`child run ${runId} 不存在`)
    const reloaded = this.deps.sessionStore.load(childSession.id) ?? childSession
    return projectSubagentExecutionResult({
      childSession: reloaded,
      runSnapshot: snapshot,
      ...(failureCode ? { failureCode } : {})
    })
  }
}

function assertInvocationIdentity(
  command: SpawnSubagentCommand,
  context: SpawnSubagentContext
): void {
  if (command.invocation.kind !== 'task_tool') return
  const ref = context.invocationRef
  if (!ref) throw new Error('task 子代理缺少完整 ToolInvocationRef')
  if (
    ref.sessionId !== command.parentSessionId ||
    ref.runId !== command.parentRunId ||
    ref.messageId !== command.invocation.parentMessageId ||
    ref.toolCallId !== command.invocation.parentToolCallId
  ) {
    throw new Error('task 子代理调用身份与 SpawnSubagentCommand 不匹配')
  }
}

export function createSpawnIdentity(command: SpawnSubagentCommand): SpawnIdentity {
  const spawnKey = createStableSpawnKey(command)
  const digest = createHash('sha256')
    .update(`spawn-run\0${spawnKey}`, 'utf8')
    .digest('hex')
  return {
    spawnKey,
    spawnRunId: [
      digest.slice(0, 8),
      digest.slice(8, 12),
      digest.slice(12, 16),
      digest.slice(16, 20),
      digest.slice(20, 32)
    ].join('-')
  }
}

function createStableSpawnKey(command: SpawnSubagentCommand): string {
  const origin = command.invocation
  const stableFields =
    origin.kind === 'task_tool'
      ? ['task_tool', command.parentRunId, origin.parentMessageId, origin.parentToolCallId]
      : [
          'workflow',
          origin.workflowRunId,
          origin.phase,
          origin.taskId ?? '',
          origin.batchId ?? ''
        ]
  const digest = createHash('sha256')
    .update(stableFields.join('\0'), 'utf8')
    .digest('hex')
  return `${origin.kind}:${digest}`
}

function resolveLineageBase(
  parentSession: SessionData,
  parentRunId: string
): { rootRunId: string; depth: number } {
  if (parentSession.kind === 'primary') {
    return { rootRunId: parentRunId, depth: 1 }
  }
  return {
    rootRunId: parentSession.subagent.lineage.rootRunId,
    depth: parentSession.subagent.lineage.depth + 1
  }
}

function validateWorkingDirectory(
  command: SpawnSubagentCommand,
  parentWorkspaceRoot: string
): void {
  if (!path.isAbsolute(command.workingDirectory)) {
    throw new Error('子代理 workingDirectory 必须是绝对路径')
  }
  if (
    command.isolation !== 'worktree' &&
    path.resolve(command.workingDirectory) !== path.resolve(parentWorkspaceRoot)
  ) {
    throw new Error('shared/readonly 子代理必须使用父会话 workspaceRoot')
  }
}

function assertChildRunIdentity(
  snapshot: RunSnapshot,
  childSession: SubagentSessionData
): void {
  if (
    snapshot.runId !== childSession.subagent.lineage.spawnRunId ||
    snapshot.sessionId !== childSession.id ||
    snapshot.workspaceId !== childSession.workspaceRoot
  ) {
    throw new Error(`child run ${snapshot.runId} 与 Child Session metadata 冲突`)
  }
}
