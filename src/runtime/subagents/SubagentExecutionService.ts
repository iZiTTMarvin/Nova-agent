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
  SubagentSessionHeader,
  SubagentLineage,
  SubagentOrigin,
  SubagentProfileSnapshot
} from '../../shared/subagents'
import { isHardTerminalRunStatus, isTerminalRunStatus, type RunSnapshot } from '../../shared/run/types'
import type { ToolInvocationRef } from '../tools/types'
import type { Mode } from '../../shared/session'
import type { SpawnSubagentContext, SpawnSubagentPort } from './ports'
import {
  applyHostArchiveReadCapability,
  resolveSubagentProfileSnapshot
} from './profileResolver'
import { projectSubagentExecutionResult } from './resultProjection'
import {
  SubagentScheduleRejectedError,
  type SubagentScheduler
} from './SubagentScheduler'

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

/**
 * 所有子代理派遣共用的壁钟兜底：并发容量与用户可感知时长的护栏，
 * 不是任务规模预算；轮数预算由 profileResolver 按 permissionCeiling 分档。
 */
export const SUBAGENT_WALL_CLOCK_TIMEOUT_MS = 15 * 60 * 1000

export interface PreparedSubagentTurn {
  readonly agentLoop: AgentLoop
  readonly eventBus: EventBus
}

export interface SubagentEventContext extends AgentTurnRunRefs {
  readonly parentRunId: string
  /** 直接父会话归属；renderer 据此把权限请求等关键事件路由到父会话视图 */
  readonly parentSessionId: string
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
  /** 派生前校验 registry 并为新 child 解析、冻结 header；不得返回凭据。 */
  readonly resolveExecutionTarget: (
    input:
      | {
          readonly profile: SubagentProfileSnapshot
          readonly modelOverride?: { readonly providerId: string; readonly modelEntryId: string }
          readonly reasoningEffort?: SubagentSessionHeader['reasoningEffort']
        }
      | { readonly header: SubagentSessionHeader }
  ) => SubagentSessionHeader
  readonly adaptEvent?: (event: AgentEvent, context: SubagentEventContext) => AgentEvent
  readonly onEvent?: (event: AgentEvent, context: SubagentEventContext) => void
  readonly onExecutionStarted?: (context: SubagentExecutionLifecycleContext) => void
  readonly onExecutionSettled?: (context: SubagentExecutionLifecycleContext) => void
  /** Child relation 已持久化后的失效通知；不得成为第二份状态。 */
  readonly onLinked?: (input: {
    readonly childSession: SubagentSessionData
    readonly created: boolean
  }) => void
  readonly maxDepth?: number
  readonly allowRecursion?: boolean
  readonly scheduler: SubagentScheduler
  readonly isRunExecutionActive?: (runId: string) => boolean
  /** 宿主是否具备 archive_read；用于子 Agent 能力继承与投影门控。 */
  readonly hostHasArchiveRead?: () => boolean
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
  private readonly allowRecursion: boolean

  constructor(private readonly deps: SubagentExecutionServiceDeps) {
    this.maxDepth = Math.min(deps.maxDepth ?? 2, 2)
    this.allowRecursion = deps.allowRecursion === true
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
    validateSpawnModelOverride(command)

    const existingChild = this.deps.sessionStore.load(
      deriveChildSessionId(identity.spawnKey)
    )
    const existingRun = this.deps.runCoordinator.getSnapshot(identity.spawnRunId)
    let profile: SubagentProfileSnapshot
    let header: SubagentSessionHeader | undefined
    if (existingChild) {
      if (existingChild.kind !== 'subagent') {
        throw new Error(`spawnKey ${identity.spawnKey} 已绑定非 Child Session`)
      }
      if (existingChild.subagent.profile.profileId !== command.profileId) {
        throw new Error(`spawnKey ${identity.spawnKey} 的 profile identity 冲突`)
      }
      if (!isSameModelOverride(existingChild.subagent.header, command)) {
        throw new Error(`spawnKey ${identity.spawnKey} 的模型覆盖冲突`)
      }
      profile = existingChild.subagent.profile
      header = existingChild.subagent.header
      if (context.profile !== undefined) {
        const supplied = resolveSubagentProfileSnapshot(context.profile, command.profileId, {
          allowRecursion: this.allowRecursion
        })
        if (supplied.configHash !== profile.configHash) {
          throw new Error(`spawnKey ${identity.spawnKey} 的 profile config 冲突`)
        }
      }
    } else {
      const rawProfile = context.profile ?? this.deps.loadProfile(command.profileId)
      if (rawProfile === undefined || rawProfile === null) {
        throw new Error(`未知子代理类型: ${command.profileId}`)
      }
      profile = resolveSubagentProfileSnapshot(rawProfile, command.profileId, {
        allowRecursion: this.allowRecursion
      })
    }
    if (
      parentSession.kind === 'subagent' &&
      parentSession.subagent.profile.permissionCeiling === 'read_only' &&
      profile.permissionCeiling === 'workspace_write'
    ) {
      throw new Error('read_only 父子代理不能派生 workspace_write 子代理')
    }
    validateSkillRoots(command, profile)
    const lineage: SubagentLineage = {
      parentSessionId: command.parentSessionId,
      parentRunId: command.parentRunId,
      rootRunId: lineageBase.rootRunId,
      depth: lineageBase.depth,
      spawnKey: identity.spawnKey,
      spawnRunId: identity.spawnRunId,
      origin: command.invocation
    }
    if (!existingChild) {
      header = this.deps.resolveExecutionTarget({
        profile,
        ...(command.modelOverride ? { modelOverride: command.modelOverride } : {}),
        ...(command.reasoningEffort !== undefined ? { reasoningEffort: command.reasoningEffort } : {})
      })
    } else if (!existingRun || !isHardTerminalRunStatus(existingRun.status)) {
      if (!header) {
        throw new Error('历史 Child Session 缺少模型 header，无法恢复；请重新派遣子代理')
      }
      this.deps.resolveExecutionTarget({ header })
    }
    const subagent = {
      lineage,
      profile,
      ...(header ? { header } : {})
    }
    const childResult = this.deps.sessionStore.createChildIfAbsent({
      workspaceRoot: command.workingDirectory,
      mode: 'default',
      permissionMode: parentSession.permissionMode,
      task: command.task,
      codeIndexEnabled: parentSession.codeIndexEnabled === true,
      subagent
    })
    const childSession = childResult.session
    this.deps.onLinked?.({ childSession, created: childResult.created })

    let recoverySnapshot: RunSnapshot | null = null
    if (existingRun) {
      try {
        assertChildRunIdentity(existingRun, childSession)
      } catch (error) {
        this.deps.runCoordinator.recordDiagnostic(
          existingRun.runId,
          'subagent_identity_conflict',
          error instanceof Error ? error.message : String(error)
        )
        throw error
      }
      if (existingRun.status === 'completed' || existingRun.status === 'failed' || existingRun.status === 'cancelled') {
        return this.projectResult(command, childSession, identity.spawnRunId)
      }
      if (this.deps.isRunExecutionActive?.(existingRun.runId)) {
        throw new Error(`child run ${existingRun.runId} 已有活跃执行句柄`)
      }
      if (existingRun.status !== 'interrupted') {
        this.deps.runCoordinator.commitTerminal({
          runId: existingRun.runId,
          status: 'interrupted',
          reason: 'child run 缺少当前进程执行句柄'
        })
      }
      let interrupted = this.deps.runCoordinator.getSnapshot(existingRun.runId)
      for (const record of interrupted?.toolCommits ?? []) {
        if (
          !record.idempotent &&
          (record.phase === 'prepared' || record.phase === 'executing')
        ) {
          this.deps.runCoordinator.recordToolPhase(
            existingRun.runId,
            record.toolCallId,
            record.toolName,
            'failed',
            { idempotent: false }
          )
        }
      }
      interrupted = this.deps.runCoordinator.getSnapshot(existingRun.runId)
      const unresolved = interrupted?.pendingInteractions.some(
        (interaction) => interaction.status === 'pending' || interaction.status === 'submitting'
      )
      if (unresolved) {
        throw new Error(`child run ${existingRun.runId} 仍有待处理交互，恢复前必须先回答或拒绝`)
      }
      recoverySnapshot = interrupted ?? null
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

    if (!existingRun && context.waitForCapacity === true) {
      const queued = this.deps.runCoordinator.startRun({
        kind: 'agent',
        runId: identity.spawnRunId,
        workspaceId: childSession.workspaceRoot,
        sessionId: childSession.id
      })
      assertChildRunIdentity(queued, childSession)
    }

    if (context.abortSignal?.aborted) {
      this.commitWithoutExecution(
        childSession,
        identity.spawnRunId,
        'cancelled',
        '父执行已取消'
      )
      return this.projectResult(command, childSession, identity.spawnRunId)
    }

    const permitResult = await this.deps.scheduler.acquire({
      runId: identity.spawnRunId,
      rootRunId: lineage.rootRunId,
      requestKey: identity.spawnKey,
      wait: context.waitForCapacity === true,
      ...(context.abortSignal ? { abortSignal: context.abortSignal } : {})
    })
    if (!permitResult.ok) {
      const current = this.deps.runCoordinator.getSnapshot(identity.spawnRunId)
      if (current && isHardTerminalRunStatus(current.status)) {
        return this.projectResult(command, childSession, identity.spawnRunId)
      }
      if (recoverySnapshot || permitResult.code === 'run_active') {
        throw new SubagentScheduleRejectedError(permitResult)
      }
      this.commitWithoutExecution(
        childSession,
        identity.spawnRunId,
        permitResult.code === 'aborted' ? 'cancelled' : 'failed',
        `scheduler:${permitResult.code}:${permitResult.message}`
      )
      return this.projectResult(
        command,
        childSession,
        identity.spawnRunId,
        permitResult.code === 'aborted' ? undefined : 'scheduler'
      )
    }

    try {
      if (recoverySnapshot) {
        const resuming = this.deps.runCoordinator.transition(
          recoverySnapshot.runId,
          'resuming',
          'subagent_resuming'
        )
        if (!resuming || resuming.status !== 'resuming') {
          throw new Error(`child run ${recoverySnapshot.runId} 无法进入 resuming`)
        }
      }
      return await this.executePrepared(
        command,
        context,
        identity,
        childSession,
        profile,
        lineage.rootRunId,
        rootRun.executionGeneration,
        recoverySnapshot
      )
    } finally {
      permitResult.permit.release()
    }
  }

  private async executePrepared(
    command: SpawnSubagentCommand,
    context: SpawnSubagentContext,
    identity: SpawnIdentity,
    childSession: SubagentSessionData,
    profile: SubagentProfileSnapshot,
    rootRunId: string,
    rootExecutionGeneration: number,
    recoverySnapshot: RunSnapshot | null
  ): Promise<SubagentExecutionResult> {

    let prepared: PreparedSubagentTurn
    try {
      const hostHasArchiveRead = this.deps.hostHasArchiveRead?.()
      const toolNames = applyHostArchiveReadCapability(
        profile.toolNames,
        hostHasArchiveRead
      )
      const executionProfile: SubagentProfileSnapshot = Object.freeze({
        ...profile,
        toolNames: Object.freeze(toolNames)
      })
      prepared = this.deps.prepareTurn({
        profile: executionProfile,
        task: command.task,
        workingDirectory: command.workingDirectory,
        isolation: command.isolation,
        ...(context.invocationRef ? { invocationRef: context.invocationRef } : {}),
        childSession,
        parentRunId: command.parentRunId,
        rootRunId
      })
    } catch (error) {
      this.commitWithoutExecution(
        childSession,
        identity.spawnRunId,
        'failed',
        error instanceof Error ? error.message : String(error)
      )
      return this.projectResult(command, childSession, identity.spawnRunId, 'host')
    }

    const runRefs: AgentTurnRunRefs = {
      runId: identity.spawnRunId,
      resourceOwnerRunId: rootRunId,
      executionGeneration: 0
    }
    const eventContext = (): SubagentEventContext => ({
      ...runRefs,
      parentRunId: command.parentRunId,
      parentSessionId: command.parentSessionId,
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
    let timedOut = false
    let parentCancelled = false
    const cancelChild = (): void => {
      parentCancelled = true
      prepared.agentLoop.cancel()
    }
    context.abortSignal?.addEventListener('abort', cancelChild, { once: true })
    const timeoutHandle =
      command.timeoutMs !== undefined && command.timeoutMs > 0
        ? setTimeout(() => {
            if (parentCancelled) return
            timedOut = true
            prepared.agentLoop.cancel()
          }, command.timeoutMs)
        : null

    try {
      const executionTask = recoverySnapshot
        ? buildRecoveryTask(command.task, recoverySnapshot)
        : command.task
      await this.deps.turnExecutor.execute({
        agentLoop: prepared.agentLoop,
        task: executionTask,
        route: agentRoute(),
        sessionId: childSession.id,
        workingDirectory: command.workingDirectory,
        isolation: command.isolation,
        ...(context.invocationRef ? { invocationRef: context.invocationRef } : {}),
        profile,
        runId: identity.spawnRunId,
        resourceOwnerRunId: rootRunId,
        resourceOwnerGeneration: rootExecutionGeneration,
        runRefs,
        onStarted: () => this.deps.onExecutionStarted?.(eventContext()),
        afterOutcome: () => {
          if (!timedOut) return
          const snapshot = this.deps.runCoordinator.getSnapshot(identity.spawnRunId)
          if (snapshot && !isTerminalRunStatus(snapshot.status)) {
            this.deps.runCoordinator.commitTerminal({
              runId: identity.spawnRunId,
              status: 'failed',
              reason: `子代理执行超时（${command.timeoutMs}ms）`
            })
          }
        },
        onCleanup: () => this.deps.onExecutionSettled?.(eventContext())
      })
    } catch {
      return this.projectResult(
        command,
        childSession,
        identity.spawnRunId,
        timedOut ? 'timeout' : 'host'
      )
    } finally {
      if (timeoutHandle !== null) clearTimeout(timeoutHandle)
      context.abortSignal?.removeEventListener('abort', cancelChild)
      unsubscribe()
      prepared.agentLoop.dispose()
    }

    return this.projectResult(
      command,
      childSession,
      identity.spawnRunId,
      timedOut ? 'timeout' : undefined
    )
  }

  private requireParentRun(command: SpawnSubagentCommand): void {
    const parentRun = this.deps.runCoordinator.getSnapshot(command.parentRunId)
    if (!parentRun || parentRun.sessionId !== command.parentSessionId) {
      throw new Error('parent session/run identity 不匹配')
    }
    if (isTerminalRunStatus(parentRun.status)) {
      throw new Error(`parent run ${command.parentRunId} 已终止`)
    }
    if (
      command.invocation.kind === 'skill_fork' &&
      command.invocation.parentToolCallId === undefined &&
      parentRun.messageId !== command.invocation.parentMessageId
    ) {
      throw new Error('skill fork 消息身份与 parent run 不匹配')
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
    command: SpawnSubagentCommand,
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
  if (command.invocation.kind === 'workflow') {
    throw new Error('workflow 子代理入口已移除，仅保留历史会话只读投影')
  }
  if (
    command.invocation.kind === 'skill_fork' &&
    command.invocation.parentToolCallId === undefined
  ) return
  const ref = context.invocationRef
  if (!ref) throw new Error('工具触发的子代理缺少完整 ToolInvocationRef')
  const parentToolCallId = command.invocation.parentToolCallId
  if (
    ref.sessionId !== command.parentSessionId ||
    ref.runId !== command.parentRunId ||
    ref.messageId !== command.invocation.parentMessageId ||
    ref.toolCallId !== parentToolCallId
  ) {
    throw new Error('工具触发的子代理调用身份与 SpawnSubagentCommand 不匹配')
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
  const stableFields = (() => {
    if (origin.kind === 'task_tool') {
      return ['task_tool', command.parentRunId, origin.parentMessageId, origin.parentToolCallId]
    }
    if (origin.kind === 'skill_fork') {
      return [
        'skill_fork',
        command.parentRunId,
        origin.parentMessageId,
        origin.parentToolCallId ?? '',
        origin.skillName
      ]
    }
    return [
      'workflow',
      origin.workflowRunId,
      origin.phase,
      origin.taskId ?? '',
      origin.batchId ?? '',
      String(origin.occurrence ?? 0)
    ]
  })()
  const digest = createHash('sha256')
    .update(stableFields.join('\0'), 'utf8')
    .digest('hex')
  return `${origin.kind}:${digest}`
}

function validateSkillRoots(
  command: SpawnSubagentCommand,
  profile: SubagentProfileSnapshot
): void {
  const roots = profile.skillRoots ?? []
  if (roots.length === 0) return
  if (command.invocation.kind !== 'skill_fork') {
    throw new Error('只有 skill_fork 子代理可以声明 skillRoots')
  }
  if (roots.some((root) => !path.isAbsolute(root))) {
    throw new Error('skillRoots 必须全部是绝对路径')
  }
}

const REASONING_EFFORT_VALUES = ['auto', 'low', 'medium', 'high', 'max'] as const

function validateSpawnModelOverride(command: SpawnSubagentCommand): void {
  if (command.modelOverride) {
    const providerId = command.modelOverride.providerId?.trim()
    const modelEntryId = command.modelOverride.modelEntryId?.trim()
    if (!providerId || !modelEntryId) {
      throw new Error('modelOverride 必须是包含 providerId 与 modelEntryId 的非空对象')
    }
  }
  if (command.reasoningEffort !== undefined) {
    if (!(REASONING_EFFORT_VALUES as readonly string[]).includes(command.reasoningEffort)) {
      throw new Error('reasoningEffort 必须是 auto/low/medium/high/max 之一')
    }
  }
}

function isSameModelOverride(
  header: SubagentSessionHeader | undefined,
  command: SpawnSubagentCommand
): boolean {
  const override = command.modelOverride
  const effort = command.reasoningEffort
  if (!override && effort === undefined) {
    // 调用方未提供覆盖，视为沿用已冻结路由；不触发冲突
    return true
  }
  if (!header) return false
  if (override) {
    if (header.providerId !== override.providerId || header.modelEntryId !== override.modelEntryId) {
      return false
    }
  }
  if (effort !== undefined && header.reasoningEffort !== effort) {
    return false
  }
  return true
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

function buildRecoveryTask(originalTask: string, snapshot: RunSnapshot): string {
  const committed = (snapshot.toolCommits ?? [])
    .filter((record) => record.phase === 'committed')
    .map((record) => `${record.toolName}:${record.toolCallId}`)
  const blockedReplay = (snapshot.toolCommits ?? [])
    .filter((record) => record.phase === 'failed' && !record.idempotent)
    .map((record) => `${record.toolName}:${record.toolCallId}`)
  const interactionDecisions = snapshot.pendingInteractions
    .filter((interaction) => interaction.status === 'answered' || interaction.status === 'dismissed')
    .map((interaction) => `${interaction.type}:${interaction.status}`)
  return [
    '继续此前因进程退出而中断的子任务。基于 Child Session 现有历史重新规划，不重新派生会话。',
    `原始任务：${originalTask}`,
    `已提交步骤：${committed.join(', ') || '无'}`,
    `禁止自动重放的未提交非幂等步骤：${blockedReplay.join(', ') || '无'}`,
    `已持久化交互决定：${interactionDecisions.join(', ') || '无'}`,
    '如果仍需等价副作用，先重新读取当前状态并选择新的、安全且可审计的操作。'
  ].join('\n')
}
