import * as path from 'path'
import { isDeepStrictEqual } from 'util'
import type { AgentEvent, AgentLoop, EventBus } from '../agent'
import {
  AgentTurnExecutor,
  agentRoute,
  applyAgentEventToRun,
  type AgentTurnRunRefs
} from '../agent/turn'
import type { RunCoordinator } from '../run/RunCoordinator'
import {
  deriveChildSessionId,
  recoverSessionTurnDrafts,
  extractTextFromSerializableContent,
  getSessionActiveMessages,
  type SessionData,
  type SessionStore,
  type SubagentSessionData
} from '../sessions'
import {
  createFollowupSpawnIdentity,
  createSpawnIdentity,
  deriveFollowupUserMessageId
} from './identity'
import { settleSubagentToolCall } from './toolSettlement'
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
import {
  isHardTerminalRunStatus,
  isTerminalRunStatus,
  type RunSnapshot,
  type SubagentRunDispatch,
  type SubagentRunDispatchCallKind,
  type ToolCommitRecord
} from '../../shared/run/types'
import type { ToolInvocationRef } from '../tools/types'
import type { SessionControlIntent } from '../sessions/types'
import type { Mode } from '../../shared/session'
import type { SpawnSubagentContext, SpawnSubagentPort } from './ports'
import {
  applyHostArchiveCapabilities,
  resolveSubagentProfileSnapshot
} from './profileResolver'
import {
  projectSubagentAcceptanceResult,
  projectSubagentExecutionResult
} from './resultProjection'
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
  /** 句柄注销后触发，用于需要 isRunExecutionActive=false 的后续动作。 */
  readonly onUnregistered?: (context: SubagentExecutionLifecycleContext) => void | Promise<void>
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
  /** 应用进入退出阶段后关闭新的后台接纳。 */
  readonly isShuttingDown?: () => boolean
}

export interface SpawnIdentity {
  readonly spawnKey: string
  readonly spawnRunId: string
}

interface ActiveSubagentExecution {
  readonly command: SpawnSubagentCommand | FollowupSubagentCommand
  readonly promise: Promise<SubagentExecutionResult>
  readonly acceptance?: Promise<SubagentExecutionResult>
}

interface StartedSubagentExecution {
  readonly result: Promise<SubagentExecutionResult>
  readonly completion: Promise<SubagentExecutionResult>
}

/** 已完成身份与归属校验的一次子代理执行的输入；spawn 与 followup 共用执行段。 */
interface ResolvedExecutionPlan {
  readonly task: string
  readonly workingDirectory: string
  readonly isolation: SpawnSubagentCommand['isolation']
  readonly timeoutMs?: number
  readonly parentSessionId: string
  readonly parentRunId: string
  readonly dispatch?: SubagentRunDispatch
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
    start: () => Promise<StartedSubagentExecution>
  ): Promise<SubagentExecutionResult> {
    const active = this.activeExecutions.get(spawnKey)
    if (active) {
      if (!isDeepStrictEqual(active.command, command)) {
        return Promise.reject(
          new Error(`spawnKey ${spawnKey} 的并发命令 metadata 冲突`)
        )
      }
      return active.acceptance ?? active.promise
    }

    const started = start()
    void started.catch(() => undefined)
    const execution = started.then(({ result }) => result)
    void execution.catch(() => undefined)
    const completion = started.then(({ completion: settled }) => settled)
    this.activeExecutions.set(spawnKey, {
      command,
      promise: completion,
      ...(isBackgroundSpawnCommand(command) ? { acceptance: execution } : {})
    })
    void completion.finally(() => {
      if (this.activeExecutions.get(spawnKey)?.promise === completion) {
        this.activeExecutions.delete(spawnKey)
      }
    }).catch(() => undefined)
    return isBackgroundSpawnCommand(command) ? execution : completion
  }

  private async spawnOnce(
    command: SpawnSubagentCommand,
    context: SpawnSubagentContext,
    identity: SpawnIdentity
  ): Promise<StartedSubagentExecution> {
    const parentSession = this.deps.sessionStore.load(command.parentSessionId)
    if (!parentSession) {
      throw new Error(`父会话 ${command.parentSessionId} 不存在`)
    }
    const childSessionId = deriveChildSessionId(identity.spawnKey)
    const existingRun = this.deps.runCoordinator.getSnapshot(identity.spawnRunId)
    // 后台接纳之后，父 run 的正常收尾不能阻止 child 继续；没有既有 queued
    // 记录时仍必须在接纳边界校验父 run。
    if (command.background !== true || !existingRun) {
      this.requireParentRun(command)
    }
    const lineageBase = resolveLineageBase(parentSession, command.parentRunId)
    if (lineageBase.depth > this.maxDepth) {
      throw new Error(`子代理深度 ${lineageBase.depth} 超过上限 ${this.maxDepth}`)
    }
    validateWorkingDirectory(command, parentSession.workspaceRoot)
    validateSpawnModelOverride(command)

    const existingChild = this.deps.sessionStore.load(childSessionId)
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
    const callKind = resolveCallKind(command)
    validateBackgroundSpawn(command, profile, callKind, this.deps.isShuttingDown)
    if (command.background === true) {
      // 剩余控制意图冻结该树接纳：覆盖本派遣的停止/分支/删除意图存在时，
      // 后台接纳在持久化 child 前拒绝，不给停止窗口塞进新的排队目标
      const intent = findCoveringControlIntent(this.deps.sessionStore, {
        topParentSessionId: resolveTopParentSessionId(
          this.deps.sessionStore,
          command.parentSessionId
        ),
        parentSessionId: command.parentSessionId,
        coverRunIds: new Set([identity.spawnRunId, command.parentRunId]),
        coverSessionIds: new Set([childSessionId, command.parentSessionId])
      })
      if (intent) {
        throw new Error(`后台接纳被控制意图冻结：control_intent:${intent.operationId}`)
      }
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

    const topParentSessionId = resolveTopParentSessionId(
      this.deps.sessionStore,
      command.parentSessionId
    )
    const originUserMessageId = this.resolveOriginUserMessageId(
      command.parentRunId,
      command.parentSessionId,
      command.invocation.parentMessageId
    )
    const dispatch = buildDispatch({
      callKind,
      parentSessionId: command.parentSessionId,
      parentRunId: command.parentRunId,
      parentMessageId: command.invocation.parentMessageId,
      parentToolCallId: command.invocation.parentToolCallId,
      topParentSessionId,
      execution: command.background === true ? 'background_read_only' : 'sync',
      ...(originUserMessageId ? { originUserMessageId } : {})
    })

    return this.runResolvedExecution(
      {
        task: command.task,
        workingDirectory: command.workingDirectory,
        isolation: command.background === true ? 'readonly' : command.isolation,
        ...(command.background === true
          ? { timeoutMs: command.timeoutMs ?? SUBAGENT_WALL_CLOCK_TIMEOUT_MS }
          : command.timeoutMs !== undefined
            ? { timeoutMs: command.timeoutMs }
            : {}),
        parentSessionId: command.parentSessionId,
        parentRunId: command.parentRunId,
        dispatch
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
  ): Promise<StartedSubagentExecution> {
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

    // resume 校验链：仅当显式 resumeRunId 存在时执行
    let resumeSource: RunSnapshot | undefined
    if (command.resumeRunId) {
      const resumeTarget = this.deps.runCoordinator.getSnapshot(command.resumeRunId)
      if (!resumeTarget) {
        throw new Error(`指定的恢复 run ${command.resumeRunId} 不存在`)
      }
      if (resumeTarget.sessionId !== command.previousChildSessionId) {
        throw new Error(
          `指定的恢复 run ${command.resumeRunId} 不属于该子会话 ${command.previousChildSessionId}`
        )
      }
      if (resumeTarget.status !== 'interrupted') {
        throw new Error(
          `只能恢复 interrupted 状态的子 run（当前 ${resumeTarget.status}）`
        )
      }
      if (this.deps.isRunExecutionActive?.(command.resumeRunId)) {
        throw new Error(`指定的恢复 run ${command.resumeRunId} 仍有活跃执行句柄`)
      }
      if (
        resumeTarget.pendingInteractions.some(
          (i) => i.status === 'pending' || i.status === 'submitting'
        )
      ) {
        throw new Error(
          `指定的恢复 run ${command.resumeRunId} 有待处理交互，需先回答或忽略`
        )
      }
      resumeSource = resumeTarget
    }

    const existingRun = this.deps.runCoordinator.getSnapshot(identity.spawnRunId)
    if (!existingRun || !isHardTerminalRunStatus(existingRun.status)) {
      this.deps.resolveExecutionTarget({ header })
    }
    const lineageBase = resolveLineageBase(parentSession, command.parentRunId)

    // 构造 dispatch
    const topParentSessionId = resolveTopParentSessionId(
      this.deps.sessionStore,
      command.parentSessionId
    )
    const originUserMessageId = this.resolveOriginUserMessageId(
      command.parentRunId,
      command.parentSessionId,
      command.parentMessageId
    )
    const dispatch = buildDispatch({
      callKind: 'task_followup',
      parentSessionId: command.parentSessionId,
      parentRunId: command.parentRunId,
      parentMessageId: command.parentMessageId,
      parentToolCallId: command.parentToolCallId,
      topParentSessionId,
      execution: 'sync',
      ...(originUserMessageId ? { originUserMessageId } : {}),
      ...(resumeSource ? { sourceChildRunId: resumeSource.runId } : {})
    })

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
        parentRunId: command.parentRunId,
        dispatch
      },
      context,
      identity,
      childSession,
      profile,
      existingRun,
      lineageBase.rootRunId,
      resumeSource
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
    const settle = (input: Parameters<typeof settleSubagentToolCall>[1]) =>
      settleSubagentToolCall(
        { sessionStore: this.deps.sessionStore, runCoordinator: this.deps.runCoordinator },
        input
      )
    recoverSessionTurnDrafts(command.previousChildSessionId, this.deps.sessionStore, this.deps.runCoordinator, settle)
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
    rootRunId: string,
    resumeSource?: RunSnapshot
  ): Promise<StartedSubagentExecution> {
    const isBackground = plan.dispatch?.execution === 'background_read_only'
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
        const result = Promise.resolve(this.projectResult(childSession, identity.spawnRunId))
        return { result, completion: result }
      }
      if (isBackground && existingRun.status === 'cancelling') {
        this.deps.runCoordinator.commitTerminal({
          runId: existingRun.runId,
          status: 'cancelled',
          reason: '后台 child 已取消'
        })
        const result = Promise.resolve(this.projectResult(childSession, identity.spawnRunId))
        return { result, completion: result }
      }
      const unstartedBackgroundRun = isBackground && existingRun.status === 'queued'
      if (!unstartedBackgroundRun && this.deps.isRunExecutionActive?.(existingRun.runId)) {
        throw new Error(`child run ${existingRun.runId} 已有活跃执行句柄`)
      }
      if (!unstartedBackgroundRun && existingRun.status !== 'interrupted') {
        this.deps.runCoordinator.commitTerminal({
          runId: existingRun.runId,
          status: 'interrupted',
          reason: 'child run 缺少当前进程执行句柄'
        })
      }
      let interrupted = unstartedBackgroundRun
        ? null
        : this.deps.runCoordinator.getSnapshot(existingRun.runId)
      if (!unstartedBackgroundRun) {
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
      }
      const unresolved = interrupted?.pendingInteractions.some(
        (interaction) => interaction.status === 'pending' || interaction.status === 'submitting'
      )
      if (unresolved) {
        throw new Error(`child run ${existingRun.runId} 仍有待处理交互，恢复前必须先回答或拒绝`)
      }
      recoverySnapshot = interrupted ?? null
    }

    const rootRun = this.deps.runCoordinator.getSnapshot(rootRunId)
    if (!isBackground && (
      !rootRun ||
      rootRun.executionGeneration === undefined ||
      !this.deps.runCoordinator.isExecutionCurrent(
        rootRunId,
        rootRun.executionGeneration
      )
    )) {
      throw new Error(`root run ${rootRunId} 的 execution generation 不可用`)
    }

    if (!existingRun && (isBackground || context.waitForCapacity === true)) {
      const queued = this.deps.runCoordinator.startRun({
        kind: 'agent',
        runId: identity.spawnRunId,
        workspaceId: childSession.workspaceRoot,
        sessionId: childSession.id,
        ...(plan.dispatch ? { dispatch: plan.dispatch } : {})
      })
      assertChildRunIdentity(queued, childSession, identity.spawnRunId)
    }

    if (!isBackground && context.abortSignal?.aborted) {
      this.commitWithoutExecution(
        childSession,
        identity.spawnRunId,
        'cancelled',
        '父执行已取消',
        plan.dispatch
      )
      const result = Promise.resolve(this.projectResult(childSession, identity.spawnRunId))
      return { result, completion: result }
    }

    const capacityKey =
      plan.dispatch?.topParentSessionId ??
      resolveTopParentSessionId(this.deps.sessionStore, plan.parentSessionId)
    const permitPromise = this.deps.scheduler.acquire({
      runId: identity.spawnRunId,
      capacityKey,
      requestKey: identity.spawnKey,
      wait: isBackground || context.waitForCapacity === true,
      ...(!isBackground && context.abortSignal
        ? { abortSignal: context.abortSignal }
        : {})
    })
    const completion = this.executeAfterPermit({
      permitPromise,
      plan,
      context,
      identity,
      childSession,
      profile,
      rootRunId,
      rootExecutionGeneration: rootRun?.executionGeneration,
      recoverySnapshot,
      resumeSource
    })
    if (!isBackground) return { result: completion, completion }

    const acceptedSnapshot = this.deps.runCoordinator.getSnapshot(identity.spawnRunId)
    if (!acceptedSnapshot) {
      throw new Error(`后台 child run ${identity.spawnRunId} 接纳后不可见`)
    }
    const accepted = Promise.resolve(projectSubagentAcceptanceResult({
      childSession,
      runSnapshot: acceptedSnapshot
    }))
    const settled = completion.catch((error) => {
      this.settleBackgroundFailure(childSession, identity.spawnRunId, plan.dispatch, error)
      return this.projectResult(childSession, identity.spawnRunId, 'host')
    })
    return { result: accepted, completion: settled }
  }

  private async executeAfterPermit(input: {
    readonly permitPromise: ReturnType<SubagentScheduler['acquire']>
    readonly plan: ResolvedExecutionPlan
    readonly context: SpawnSubagentContext
    readonly identity: SpawnIdentity
    readonly childSession: SubagentSessionData
    readonly profile: SubagentProfileSnapshot
    readonly rootRunId: string
    readonly rootExecutionGeneration?: number
    readonly recoverySnapshot: RunSnapshot | null
    readonly resumeSource?: RunSnapshot
  }): Promise<SubagentExecutionResult> {
    const {
      permitPromise,
      plan,
      context,
      identity,
      childSession,
      profile,
      rootRunId,
      rootExecutionGeneration,
      recoverySnapshot,
      resumeSource
    } = input
    const isBackground = plan.dispatch?.execution === 'background_read_only'
    const permitResult = await permitPromise
    if (!permitResult.ok) {
      const current = this.deps.runCoordinator.getSnapshot(identity.spawnRunId)
      if (
        current &&
        (
          isHardTerminalRunStatus(current.status) ||
          (isBackground && isTerminalRunStatus(current.status))
        )
      ) {
        return this.projectResult(childSession, identity.spawnRunId)
      }
      if (recoverySnapshot || permitResult.code === 'run_active') {
        throw new SubagentScheduleRejectedError(permitResult)
      }
      this.commitWithoutExecution(
        childSession,
        identity.spawnRunId,
        permitResult.code === 'aborted' ? 'cancelled' : 'failed',
        `scheduler:${permitResult.code}:${permitResult.message}`,
        plan.dispatch
      )
      return this.projectResult(
        childSession,
        identity.spawnRunId,
        permitResult.code === 'aborted' ? undefined : 'scheduler'
      )
    }

    try {
      const current = this.deps.runCoordinator.getSnapshot(identity.spawnRunId)
      if (
        current &&
        (
          isHardTerminalRunStatus(current.status) ||
          (isBackground && isTerminalRunStatus(current.status))
        )
      ) {
        return this.projectResult(childSession, identity.spawnRunId)
      }
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
      if (isBackground) {
        const rejection = this.validateBackgroundAfterPermit(
          plan,
          identity.spawnRunId,
          childSession.id
        )
        if (rejection) {
          this.commitWithoutExecution(
            childSession,
            identity.spawnRunId,
            rejection.status,
            rejection.reason,
            plan.dispatch
          )
          return this.projectResult(childSession, identity.spawnRunId)
        }
      }
      return await this.executePrepared(
        plan,
        context,
        identity,
        childSession,
        profile,
        rootRunId,
        rootExecutionGeneration,
        recoverySnapshot,
        resumeSource
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
    rootExecutionGeneration: number | undefined,
    recoverySnapshot: RunSnapshot | null,
    resumeSource?: RunSnapshot
  ): Promise<SubagentExecutionResult> {
    const isBackground = plan.dispatch?.execution === 'background_read_only'
    const abortSignal = isBackground ? undefined : context.abortSignal

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
        error instanceof Error ? error.message : String(error),
        plan.dispatch
      )
      return this.projectResult(childSession, identity.spawnRunId, 'host')
    }

    const runRefs: AgentTurnRunRefs = {
      runId: identity.spawnRunId,
      resourceOwnerRunId: isBackground ? identity.spawnRunId : rootRunId,
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
      applyAgentEventToRun(
        {
          runCoordinator: this.deps.runCoordinator,
          runId: currentContext.runId,
          resourceOwnerRunId: currentContext.resourceOwnerRunId,
          sessionId: currentContext.childSessionId
        },
        adapted,
        () => {
          this.deps.runCoordinator.touchHeartbeat(currentContext.runId)
          this.deps.onEvent?.(adapted, currentContext)
        }
      )
    })
    let timedOut = false
    let parentCancelled = false
    const cancelChild = (): void => {
      parentCancelled = true
      prepared.agentLoop.cancel()
    }
    abortSignal?.addEventListener('abort', cancelChild, { once: true })
    const timeoutHandle =
      plan.timeoutMs !== undefined && plan.timeoutMs > 0
        ? setTimeout(() => {
            if (parentCancelled) return
            timedOut = true
            prepared.agentLoop.cancel()
          }, plan.timeoutMs)
        : null

    // 收尾必须在句柄 settled 前完成：Registry 句柄清空即代表订阅已释放、loop 已
    // dispose、完成唤醒已发出。否则空 Registry 会误放行抢先读取结果的 live drain。
    // 幂等保护：执行器 context 未建立（如 startRun 身份冲突）时不触发 onCleanup，
    // catch 兜底一次；正常路径由执行器 finally 先 await onCleanup 再 settled。
    let cleanedUp = false
    const cleanupOnce = (): void => {
      if (cleanedUp) return
      cleanedUp = true
      if (timeoutHandle !== null) clearTimeout(timeoutHandle)
      abortSignal?.removeEventListener('abort', cancelChild)
      unsubscribe()
      prepared.agentLoop.dispose()
    }
    try {
      const recoverySnapshots = [resumeSource, recoverySnapshot].filter(Boolean) as readonly RunSnapshot[]
      const executionTask =
        recoverySnapshots.length > 0
          ? buildRecoveryTask(plan.task, recoverySnapshots)
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
        resourceOwnerRunId: isBackground ? identity.spawnRunId : rootRunId,
        ...(!isBackground && rootExecutionGeneration !== undefined
          ? { resourceOwnerGeneration: rootExecutionGeneration }
          : {}),
        runRefs,
        userMessageId: executionUserMessage.id,
        ...(plan.dispatch ? { dispatch: plan.dispatch } : {}),
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
        onCleanup: () => {
          cleanupOnce()
          // 返回值传回执行器：完成唤醒（含其异步收尾）全部结束才算收尾完成
          return this.deps.onExecutionSettled?.(eventContext())
        },
        onUnregistered: () => this.deps.onUnregistered?.(eventContext())
      })
    } catch {
      cleanupOnce()
      return this.projectResult(
        childSession,
        identity.spawnRunId,
        timedOut ? 'timeout' : 'host'
      )
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

  /** 活跃轮的发起用户消息在 turnDraft 投递事实中；已归档轮回退消息树沿 parentId 上溯。接力消息不算用户来源，继续上溯。 */
  private resolveOriginUserMessageId(
    parentRunId: string,
    parentSessionId: string,
    parentMessageId: string
  ): string | undefined {
    const fromDraft =
      this.deps.runCoordinator.getSnapshot(parentRunId)?.turnDraft?.userDelivery?.userMessageId
    const session = this.deps.sessionStore.load(parentSessionId)
    if (session) {
      const byId = new Map(session.messages.map(m => [m.id, m]))
      const seen = new Set<string>()
      let current = byId.get(fromDraft ?? parentMessageId)
      // 有界上溯，seen 防环；跳过接力消息（internalSource），归一到真实用户消息
      for (let hop = 0; current && hop < 64; hop++) {
        if (seen.has(current.id)) break
        seen.add(current.id)
        if (current.role === 'user' && current.internalSource === undefined) return current.id
        current = current.parentId ? byId.get(current.parentId) : undefined
      }
    }
    return fromDraft
  }

  private commitWithoutExecution(
    childSession: SubagentSessionData,
    runId: string,
    status: 'failed' | 'cancelled' | 'interrupted',
    reason: string,
    dispatch?: SubagentRunDispatch
  ): void {
    const snapshot = this.deps.runCoordinator.startRun({
      kind: 'agent',
      runId,
      workspaceId: childSession.workspaceRoot,
      sessionId: childSession.id,
      ...(dispatch ? { dispatch } : {})
    })
    assertChildRunIdentity(snapshot, childSession, runId)
    if (!isTerminalRunStatus(snapshot.status)) {
      if (snapshot.status !== 'running') this.deps.runCoordinator.markRunning(runId)
      this.deps.runCoordinator.commitTerminal({ runId, status, reason })
    }
  }

  private validateBackgroundAfterPermit(
    plan: ResolvedExecutionPlan,
    childRunId: string,
    childSessionId: string
  ): { status: 'cancelled' | 'failed' | 'interrupted'; reason: string } | null {
    if (this.deps.isShuttingDown?.()) {
      return { status: 'interrupted', reason: 'process_exit' }
    }
    const childRun = this.deps.runCoordinator.getSnapshot(childRunId)
    if (!childRun) {
      return { status: 'failed', reason: '后台 child run 不存在' }
    }
    if (childRun.status === 'cancelling') {
      return { status: 'cancelled', reason: '后台 child run 已取消' }
    }
    // 分支失效化的持久证据记在源 run（child）自己的投递控制上；迟到 permit 不得执行已失效派遣。
    if (childRun.deliveryBinding?.invalidatedReason) {
      return {
        status: 'cancelled',
        reason: `后台派遣已失效：${childRun.deliveryBinding.invalidatedReason}`
      }
    }
    const parentSession = this.deps.sessionStore.load(plan.parentSessionId)
    if (!parentSession) {
      return { status: 'failed', reason: `父会话 ${plan.parentSessionId} 不存在` }
    }
    const parentRun = this.deps.runCoordinator.getSnapshot(plan.parentRunId)
    if (parentRun && parentRun.sessionId !== plan.parentSessionId) {
      return { status: 'failed', reason: '后台派遣的 parent session/run identity 不匹配' }
    }
    const topParentSessionId =
      plan.dispatch?.topParentSessionId ??
      resolveTopParentSessionId(this.deps.sessionStore, plan.parentSessionId)
    const intent = findCoveringControlIntent(this.deps.sessionStore, {
      topParentSessionId,
      parentSessionId: plan.parentSessionId,
      coverRunIds: new Set([childRunId, plan.parentRunId]),
      coverSessionIds: new Set([childSessionId, plan.parentSessionId])
    })
    if (intent) {
      return {
        status: 'cancelled',
        reason: `control_intent:${intent.operationId}`
      }
    }
    return null
  }

  private settleBackgroundFailure(
    childSession: SubagentSessionData,
    runId: string,
    dispatch: SubagentRunDispatch | undefined,
    error: unknown
  ): void {
    const snapshot = this.deps.runCoordinator.getSnapshot(runId)
    if (!snapshot) {
      this.commitWithoutExecution(
        childSession,
        runId,
        'failed',
        error instanceof Error ? error.message : String(error),
        dispatch
      )
      return
    }
    if (isTerminalRunStatus(snapshot.status)) return
    this.deps.runCoordinator.commitTerminal({
      runId,
      status: snapshot.status === 'cancelling' ? 'cancelled' : 'failed',
      reason: error instanceof Error ? error.message : String(error)
    })
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

function resolveCallKind(command: SpawnSubagentCommand): SubagentRunDispatchCallKind {
  if (command.invocation.kind === 'task_tool') {
    return command.invocation.parentToolCallId.includes(':batch:')
      ? 'batch_task'
      : 'task'
  }
  if (command.invocation.kind === 'skill_fork') return 'skill_fork'
  return 'task'
}

function isBackgroundSpawnCommand(
  command: SpawnSubagentCommand | FollowupSubagentCommand
): command is SpawnSubagentCommand {
  return 'background' in command && command.background === true
}

function validateBackgroundSpawn(
  command: SpawnSubagentCommand,
  profile: SubagentProfileSnapshot,
  callKind: SubagentRunDispatchCallKind,
  isShuttingDown: (() => boolean) | undefined
): void {
  if (command.background !== true) return
  if (callKind !== 'task') {
    throw new Error('后台子代理仅支持只读 task，batch_task 与 skill fork 保持同步契约')
  }
  // 生效上限与 SubagentRuntimeFactory.resolveReadonlyCeiling 一致：
  // profile 或调用隔离任一要求只读即为 read_only，不按 profile 名字判断。
  if (profile.permissionCeiling !== 'read_only' && command.isolation !== 'readonly') {
    throw new Error('拒绝后台：首版仅支持只读后台任务')
  }
  if (isShuttingDown?.()) {
    throw new Error('应用正在退出，已关闭后台子代理接纳')
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

function buildRecoveryTask(originalTask: string, snapshots: readonly RunSnapshot[]): string {
  const allCommits = new Map<string, ToolCommitRecord>()
  for (const snap of snapshots) {
    for (const record of snap.toolCommits ?? []) {
      const existing = allCommits.get(record.toolCallId)
      // later snapshot wins for a given toolCallId
      if (!existing || record.phase === 'committed') {
        allCommits.set(record.toolCallId, record)
      }
    }
  }
  const committed = [...allCommits.values()]
    .filter((record) => record.phase === 'committed')
    .map((record) => `${record.toolName}:${record.toolCallId}`)
  const blockedReplay = [...allCommits.values()]
    .filter((record) => record.phase !== 'committed' && !record.idempotent)
    .map((record) => `${record.toolName}:${record.toolCallId}`)
  const allInteractions = new Map<string, { status: string }>()
  for (const snap of snapshots) {
    for (const interaction of snap.pendingInteractions) {
      // later snapshot wins
      allInteractions.set(interaction.interactionId, interaction)
    }
  }
  const interactionDecisions = [...allInteractions.values()]
    .filter((interaction) => interaction.status === 'answered' || interaction.status === 'dismissed')
    .map((interaction) => `${interaction.status}`)
  return [
    '继续此前因进程退出而中断的子任务。基于 Child Session 现有历史重新规划，不重新派生会话。',
    `原始任务：${originalTask}`,
    `已提交步骤：${committed.join(', ') || '无'}`,
    `禁止自动重放的未提交非幂等步骤：${blockedReplay.join(', ') || '无'}`,
    `已持久化交互决定：${interactionDecisions.join(', ') || '无'}`,
    '如果仍需等价副作用，先重新读取当前状态并选择新的、安全且可审计的操作。'
  ].join('\n')
}

/**
 * 查询覆盖本派遣的控制意图，含父会话和单独停止时的 child 会话。
 * 无覆盖意图返回 null；损坏意图由 decoder 抛错，失败关闭。
 */
function findCoveringControlIntent(
  sessionStore: SessionStore,
  input: {
    readonly topParentSessionId: string
    readonly parentSessionId: string
    readonly coverRunIds: ReadonlySet<string>
    readonly coverSessionIds: ReadonlySet<string>
  }
): SessionControlIntent | null {
  for (const sessionId of new Set([input.topParentSessionId, input.parentSessionId, ...input.coverSessionIds])) {
    const intent = sessionStore.getControlIntent(sessionId)
    if (!intent) continue
    if (
      intent.targetRunIds.some((runId) => input.coverRunIds.has(runId)) ||
      intent.targetSessionIds.some((targetSessionId) => input.coverSessionIds.has(targetSessionId))
    ) {
      return intent
    }
  }
  return null
}

/**
 * 沿 lineage 上溯到顶层父会话（有界）。
 * 遇到 kind='primary' 或路径断裂时回落为当前 sessionId。
 */
function resolveTopParentSessionId(
  sessionStore: SessionStore,
  sessionId: string,
  maxDepth = 20
): string {
  let current = sessionId
  let depth = 0
  while (depth < maxDepth) {
    const session = sessionStore.load(current)
    if (!session || session.kind === 'primary') break
    const parentId = session.subagent?.lineage?.parentSessionId
    if (!parentId) break
    current = parentId
    depth++
  }
  return current
}

/**
 * 构造子 run 的派遣关联。
 * 发起用户消息 id 用于自动接力预算，接纳时从父轮投递事实解析。
 */
function buildDispatch(opts: {
  callKind: SubagentRunDispatchCallKind
  parentSessionId: string
  parentRunId: string
  parentMessageId: string
  parentToolCallId?: string
  topParentSessionId: string
  execution: SubagentRunDispatch['execution']
  originUserMessageId?: string
  sourceChildRunId?: string
}): SubagentRunDispatch {
  return {
    version: 1,
    callKind: opts.callKind,
    parentSessionId: opts.parentSessionId,
    parentRunId: opts.parentRunId,
    parentMessageId: opts.parentMessageId,
    ...(opts.parentToolCallId ? { parentToolCallId: opts.parentToolCallId } : {}),
    execution: opts.execution,
    topParentSessionId: opts.topParentSessionId,
    ...(opts.originUserMessageId ? { originUserMessageId: opts.originUserMessageId } : {}),
    ...(opts.sourceChildRunId ? { sourceChildRunId: opts.sourceChildRunId } : {})
  }
}
