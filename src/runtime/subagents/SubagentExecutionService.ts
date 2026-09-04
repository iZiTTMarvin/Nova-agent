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
  extractTextFromSerializableContent,
  getSessionActiveMessages,
  type SessionData,
  type SessionStore,
  type SubagentSessionData
} from '../sessions'
import type {
  FollowupSubagentCommand,
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
  applyHostArchiveCapabilities,
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
  /** 按会话查进程内执行句柄，主进程由 registry 组合实现。 */
  readonly hasSessionExecutionHandle?: (sessionId: string) => boolean
  /** 宿主是否具备 archive_read；用于子 Agent 能力继承与投影门控。 */
  readonly hostHasArchiveRead?: () => boolean
}

export interface SpawnIdentity {
  readonly spawnKey: string
  readonly spawnRunId: string
}

interface ActiveSubagentExecution {
  readonly command: SpawnSubagentCommand | FollowupSubagentCommand
  readonly promise: Promise<SubagentExecutionResult>
}

/** 已完成身份与归属校验的一次子代理执行的输入；spawn 与 followup 共用执行段。 */
interface ResolvedExecutionPlan {
  readonly task: string
  readonly workingDirectory: string
  readonly isolation: SpawnSubagentCommand['isolation']
  readonly timeoutMs?: number
  readonly parentSessionId: string
  readonly parentRunId: string
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
    return this.runDeduplicated(identity.spawnKey, command, () =>
      this.spawnOnce(command, context, identity)
    )
  }

  followup(
    command: FollowupSubagentCommand,
    context: SpawnSubagentContext = {}
  ): Promise<SubagentExecutionResult> {
    let identity: SpawnIdentity
    try {
      assertFollowupInvocationIdentity(command, context)
      identity = createFollowupSpawnIdentity(command)
    } catch (error) {
      return Promise.reject(error)
    }
    return this.runDeduplicated(identity.spawnKey, command, () =>
      this.followupOnce(command, context, identity)
    )
  }

  private runDeduplicated(
    spawnKey: string,
    command: SpawnSubagentCommand | FollowupSubagentCommand,
    start: () => Promise<SubagentExecutionResult>
  ): Promise<SubagentExecutionResult> {
    const active = this.activeExecutions.get(spawnKey)
    if (active) {
      if (!isDeepStrictEqual(active.command, command)) {
        return Promise.reject(
          new Error(`spawnKey ${spawnKey} 的并发命令 metadata 冲突`)
        )
      }
      return active.promise
    }

    const execution = start()
    this.activeExecutions.set(spawnKey, { command, promise: execution })
    void execution.finally(() => {
      if (this.activeExecutions.get(spawnKey)?.promise === execution) {
        this.activeExecutions.delete(spawnKey)
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

    const childSessionId = deriveChildSessionId(identity.spawnKey)
    const existingChild = this.deps.sessionStore.load(childSessionId)
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
      childSessionId,
      workspaceRoot: command.workingDirectory,
      mode: 'default',
      permissionMode: parentSession.permissionMode,
      task: command.task,
      codeIndexEnabled: parentSession.codeIndexEnabled === true,
      subagent
    })
    const childSession = childResult.session
    this.deps.onLinked?.({ childSession, created: childResult.created })

    return this.runResolvedExecution(
      {
        task: command.task,
        workingDirectory: command.workingDirectory,
        isolation: command.isolation,
        ...(command.timeoutMs !== undefined ? { timeoutMs: command.timeoutMs } : {}),
        parentSessionId: command.parentSessionId,
        parentRunId: command.parentRunId
      },
      context,
      identity,
      childSession,
      profile,
      existingRun,
      lineageBase.rootRunId
    )
  }

  private async followupOnce(
    command: FollowupSubagentCommand,
    context: SpawnSubagentContext,
    identity: SpawnIdentity
  ): Promise<SubagentExecutionResult> {
    const parentSession = this.deps.sessionStore.load(command.parentSessionId)
    if (!parentSession) {
      throw new Error(`父会话 ${command.parentSessionId} 不存在`)
    }
    this.requireParentRunAlive(command.parentSessionId, command.parentRunId)

    const targetChild = this.deps.sessionStore.load(command.previousChildSessionId)
    if (!targetChild) {
      throw new Error(`目标子会话 ${command.previousChildSessionId} 不存在`)
    }
    if (targetChild.kind !== 'subagent') {
      throw new Error(`目标会话 ${command.previousChildSessionId} 不是子代理会话`)
    }
    if (targetChild.subagent.lineage.parentSessionId !== command.parentSessionId) {
      throw new Error(
        `目标子会话 ${command.previousChildSessionId} 不属于父会话 ${command.parentSessionId}`
      )
    }
    // 排除自己的 spawnRunId：同一 followup 调用崩溃后重试需经共享段收敛 interrupted 再恢复，不能按忙拒绝
    if (
      this.deps.runCoordinator.hasActiveRunForSession(command.previousChildSessionId, {
        excludeRunId: identity.spawnRunId
      })
    ) {
      throw new Error(`子会话 ${command.previousChildSessionId} 正在执行中，请稍后重试`)
    }
    if (this.deps.hasSessionExecutionHandle?.(command.previousChildSessionId)) {
      throw new Error(`子会话 ${command.previousChildSessionId} 的执行尚未收敛，请稍后重试`)
    }
    // 与 spawnOnce 恢复路径的 unresolved 检查同理：挂着没人回答的授权时继续执行会让交互状态错乱
    const latest = this.deps.runCoordinator.getSnapshotForSession(
      command.previousChildSessionId
    )
    if (
      latest?.status === 'interrupted' &&
      latest.pendingInteractions.some(
        (interaction) => interaction.status === 'pending' || interaction.status === 'submitting'
      )
    ) {
      throw new Error(
        `子会话 ${command.previousChildSessionId} 有待处理的授权请求，请先回答或忽略后再继续`
      )
    }
    const profile = targetChild.subagent.profile
    const header = targetChild.subagent.header
    if (!header) {
      throw new Error('历史子会话缺少模型 header，无法 followup；请重新派遣子代理')
    }

    const existingRun = this.deps.runCoordinator.getSnapshot(identity.spawnRunId)
    if (!existingRun || !isHardTerminalRunStatus(existingRun.status)) {
      this.deps.resolveExecutionTarget({ header })
    }
    const lineageBase = resolveLineageBase(parentSession, command.parentRunId)

    // 指令先落子会话历史再执行：后续 followup 恢复上下文与详情弹窗都要看到
    // 当初的追加指令。硬终态重放路径不写——重放的是旧执行，不引入新指令。
    let childSession = targetChild
    if (!existingRun || !isHardTerminalRunStatus(existingRun.status)) {
      childSession = this.persistFollowupInstruction(command, identity) ?? targetChild
    }

    // 不走 createChildIfAbsent：既有子会话没有可创建的关系，而创建路径会用
    // 命令 task 与首条消息深比较，followup 的 task 是新指令，语义上不该经过它；
    // 存在性与归属已在上面校验。
    return this.runResolvedExecution(
      {
        task: command.task,
        workingDirectory: childSession.workspaceRoot,
        isolation: profile.permissionCeiling === 'read_only' ? 'readonly' : 'shared',
        timeoutMs: SUBAGENT_WALL_CLOCK_TIMEOUT_MS,
        parentSessionId: command.parentSessionId,
        parentRunId: command.parentRunId
      },
      context,
      identity,
      childSession,
      profile,
      existingRun,
      lineageBase.rootRunId
    )
  }

  /**
   * 把追加指令持久化为子会话的 user 消息。消息 id 由 spawnKey 确定，
   * 崩溃后重试命中 already_exists 不重复写入；同 id 不同文本属 durable
   * 身份冲突，fail closed。
   */
  private persistFollowupInstruction(
    command: FollowupSubagentCommand,
    identity: SpawnIdentity
  ): SubagentSessionData | null {
    const messageId = deriveFollowupUserMessageId(identity.spawnKey)
    const append = this.deps.sessionStore.appendMessageFast(command.previousChildSessionId, {
      id: messageId,
      role: 'user',
      content: command.task,
      timestamp: Date.now()
    })
    if (!append.ok) {
      throw new Error(
        `追加 followup 指令到子会话 ${command.previousChildSessionId} 失败: ${append.error}`
      )
    }
    const reloaded = this.deps.sessionStore.load(command.previousChildSessionId)
    if (reloaded?.kind !== 'subagent') {
      throw new Error(`子会话 ${command.previousChildSessionId} 的 followup 指令持久化后不可见`)
    }
    const persisted = reloaded.messages.find((message) => message.id === messageId)
    if (!persisted || persisted.role !== 'user') {
      throw new Error(`子会话 ${command.previousChildSessionId} 的 followup 指令持久化后不可见`)
    }
    if (extractTextFromSerializableContent(persisted.content) !== command.task) {
      throw new Error(`spawnKey ${identity.spawnKey} 的 followup 指令文本与既有持久化记录冲突`)
    }
    return reloaded
  }

  /** spawn 与 followup 的共用执行段：run 收敛、root 栅栏、排队、调度与最终 turn。 */
  private async runResolvedExecution(
    plan: ResolvedExecutionPlan,
    context: SpawnSubagentContext,
    identity: SpawnIdentity,
    childSession: SubagentSessionData,
    profile: SubagentProfileSnapshot,
    existingRun: RunSnapshot | null,
    rootRunId: string
  ): Promise<SubagentExecutionResult> {
    let recoverySnapshot: RunSnapshot | null = null
    if (existingRun) {
      try {
        assertChildRunIdentity(existingRun, childSession, identity.spawnRunId)
      } catch (error) {
        this.deps.runCoordinator.recordDiagnostic(
          existingRun.runId,
          'subagent_identity_conflict',
          error instanceof Error ? error.message : String(error)
        )
        throw error
      }
      if (existingRun.status === 'completed' || existingRun.status === 'failed' || existingRun.status === 'cancelled') {
        return this.projectResult(childSession, identity.spawnRunId)
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

    const rootRun = this.deps.runCoordinator.getSnapshot(rootRunId)
    if (
      !rootRun ||
      rootRun.executionGeneration === undefined ||
      !this.deps.runCoordinator.isExecutionCurrent(
        rootRunId,
        rootRun.executionGeneration
      )
    ) {
      throw new Error(`root run ${rootRunId} 的 execution generation 不可用`)
    }

    if (!existingRun && context.waitForCapacity === true) {
      const queued = this.deps.runCoordinator.startRun({
        kind: 'agent',
        runId: identity.spawnRunId,
        workspaceId: childSession.workspaceRoot,
        sessionId: childSession.id
      })
      assertChildRunIdentity(queued, childSession, identity.spawnRunId)
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

    const permitResult = await this.deps.scheduler.acquire({
      runId: identity.spawnRunId,
      rootRunId,
      requestKey: identity.spawnKey,
      wait: context.waitForCapacity === true,
      ...(context.abortSignal ? { abortSignal: context.abortSignal } : {})
    })
    if (!permitResult.ok) {
      const current = this.deps.runCoordinator.getSnapshot(identity.spawnRunId)
      if (current && isHardTerminalRunStatus(current.status)) {
        return this.projectResult(childSession, identity.spawnRunId)
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
        plan,
        context,
        identity,
        childSession,
        profile,
        rootRunId,
        rootRun.executionGeneration,
        recoverySnapshot
      )
    } finally {
      permitResult.permit.release()
    }
  }

  private async executePrepared(
    plan: ResolvedExecutionPlan,
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
      const toolNames = applyHostArchiveCapabilities(
        profile.toolNames,
        hostHasArchiveRead
      )
      const executionProfile: SubagentProfileSnapshot = Object.freeze({
        ...profile,
        toolNames: Object.freeze(toolNames)
      })
      prepared = this.deps.prepareTurn({
        profile: executionProfile,
        task: plan.task,
        workingDirectory: plan.workingDirectory,
        isolation: plan.isolation,
        ...(context.invocationRef ? { invocationRef: context.invocationRef } : {}),
        childSession,
        parentRunId: plan.parentRunId,
        rootRunId
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
      resourceOwnerRunId: rootRunId,
      executionGeneration: 0
    }
    const executionUserMessage = [...getSessionActiveMessages(childSession)]
      .reverse()
      .find(message =>
        message.role === 'user'
        && extractTextFromSerializableContent(message.content) === plan.task
      )
    if (!executionUserMessage) {
      throw new Error(`子代理执行任务缺少持久化用户消息: ${childSession.id}`)
    }
    const eventContext = (): SubagentEventContext => ({
      ...runRefs,
      parentRunId: plan.parentRunId,
      parentSessionId: plan.parentSessionId,
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
      plan.timeoutMs !== undefined && plan.timeoutMs > 0
        ? setTimeout(() => {
            if (parentCancelled) return
            timedOut = true
            prepared.agentLoop.cancel()
          }, plan.timeoutMs)
        : null

    try {
      const executionTask = recoverySnapshot
        ? buildRecoveryTask(plan.task, recoverySnapshot)
        : plan.task
      await this.deps.turnExecutor.execute({
        agentLoop: prepared.agentLoop,
        task: executionTask,
        route: agentRoute(),
        sessionId: childSession.id,
        workingDirectory: plan.workingDirectory,
        isolation: plan.isolation,
        ...(context.invocationRef ? { invocationRef: context.invocationRef } : {}),
        profile,
        runId: identity.spawnRunId,
        resourceOwnerRunId: rootRunId,
        resourceOwnerGeneration: rootExecutionGeneration,
        runRefs,
        userMessageId: executionUserMessage.id,
        onStarted: () => this.deps.onExecutionStarted?.(eventContext()),
        afterOutcome: () => {
          if (!timedOut) return
          const snapshot = this.deps.runCoordinator.getSnapshot(identity.spawnRunId)
          if (snapshot && !isTerminalRunStatus(snapshot.status)) {
            this.deps.runCoordinator.commitTerminal({
              runId: identity.spawnRunId,
              status: 'failed',
              reason: `子代理执行超时（${plan.timeoutMs}ms）`
            })
          }
        },
        onCleanup: () => this.deps.onExecutionSettled?.(eventContext())
      })
    } catch {
      return this.projectResult(
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
      childSession,
      identity.spawnRunId,
      timedOut ? 'timeout' : undefined
    )
  }

  private requireParentRunAlive(parentSessionId: string, parentRunId: string): RunSnapshot {
    const parentRun = this.deps.runCoordinator.getSnapshot(parentRunId)
    if (!parentRun || parentRun.sessionId !== parentSessionId) {
      throw new Error('parent session/run identity 不匹配')
    }
    if (isTerminalRunStatus(parentRun.status)) {
      throw new Error(`parent run ${parentRunId} 已终止`)
    }
    return parentRun
  }

  private requireParentRun(command: SpawnSubagentCommand): void {
    const parentRun = this.requireParentRunAlive(
      command.parentSessionId,
      command.parentRunId
    )
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
    assertChildRunIdentity(snapshot, childSession, runId)
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

function invocationRefMatches(
  ref: ToolInvocationRef,
  expected: {
    readonly parentSessionId: string
    readonly parentRunId: string
    readonly parentMessageId: string
    readonly parentToolCallId: string | undefined
  }
): boolean {
  return (
    ref.sessionId === expected.parentSessionId &&
    ref.runId === expected.parentRunId &&
    ref.messageId === expected.parentMessageId &&
    ref.toolCallId === expected.parentToolCallId
  )
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
  if (
    !invocationRefMatches(ref, {
      parentSessionId: command.parentSessionId,
      parentRunId: command.parentRunId,
      parentMessageId: command.invocation.parentMessageId,
      parentToolCallId: command.invocation.parentToolCallId
    })
  ) {
    throw new Error('工具触发的子代理调用身份与 SpawnSubagentCommand 不匹配')
  }
}

function assertFollowupInvocationIdentity(
  command: FollowupSubagentCommand,
  context: SpawnSubagentContext
): void {
  const ref = context.invocationRef
  if (!ref) throw new Error('followup 缺少完整 ToolInvocationRef')
  if (!invocationRefMatches(ref, command)) {
    throw new Error('followup 调用身份与 FollowupSubagentCommand 不匹配')
  }
}

function deriveSpawnRunId(spawnKey: string): string {
  const digest = createHash('sha256')
    .update(`spawn-run\0${spawnKey}`, 'utf8')
    .digest('hex')
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    digest.slice(12, 16),
    digest.slice(16, 20),
    digest.slice(20, 32)
  ].join('-')
}

function hashStableFields(stableFields: readonly string[]): string {
  return createHash('sha256')
    .update(stableFields.join('\0'), 'utf8')
    .digest('hex')
}

export function createSpawnIdentity(command: SpawnSubagentCommand): SpawnIdentity {
  const spawnKey = createStableSpawnKey(command)
  return { spawnKey, spawnRunId: deriveSpawnRunId(spawnKey) }
}

/**
 * followup 的稳定身份：同一次 followup 工具调用幂等，不同调用得到不同 run；
 * 与 task_tool 分支同构，previousChildSessionId 保证不同子会话的 followup 互不冲突。
 */
export function createFollowupSpawnIdentity(
  command: FollowupSubagentCommand
): SpawnIdentity {
  const spawnKey = `task_followup:${hashStableFields([
    'task_followup',
    command.parentRunId,
    command.parentMessageId,
    command.parentToolCallId,
    command.previousChildSessionId
  ])}`
  return { spawnKey, spawnRunId: deriveSpawnRunId(spawnKey) }
}

/** followup 指令在子会话中的持久化消息 id；同一次调用重试不产生第二条指令。 */
function deriveFollowupUserMessageId(spawnKey: string): string {
  const digest = createHash('sha256')
    .update(`followup-task\0${spawnKey}`, 'utf8')
    .digest('hex')
  return `msg_sub_user_${digest.slice(0, 32)}`
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
  return `${origin.kind}:${hashStableFields(stableFields)}`
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
  childSession: SubagentSessionData,
  expectedRunId: string
): void {
  if (
    snapshot.runId !== expectedRunId ||
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
