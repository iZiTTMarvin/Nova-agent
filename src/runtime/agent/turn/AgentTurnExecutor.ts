import type { ContentBlock } from '../../model/types'
import type { AgentLoop } from '../AgentLoop'
import type { SubagentProfileSnapshot } from '../../../shared/subagents'
import {
  isTerminalRunStatus,
  type CommitTerminalParams,
  type RunSnapshot
} from '../../../shared/run/types'
import type { ToolInvocationRef } from '../../tools/types'
import type { RunCoordinator } from '../../run/RunCoordinator'
import type { RunExecutionRegistry } from '../../run/RunExecutionRegistry'
import type { AgentTurnRoute } from './resolveAgentTurnRoute'
import type { AgentTurnOutcome } from './turnOutcome'

interface RunTerminalPort {
  getSnapshot(runId: string): Pick<RunSnapshot, 'status'> | null
  commitTerminal(params: CommitTerminalParams): void
}

/** start/resume 后的异常只能把仍非终态的 run 收敛为 interrupted。 */
export function interruptAgentTurnAfterFailure(
  coordinator: RunTerminalPort,
  runId: string | null,
  error: unknown
): boolean {
  if (!runId) return false
  const snapshot = coordinator.getSnapshot(runId)
  if (!snapshot || isTerminalRunStatus(snapshot.status)) return false
  coordinator.commitTerminal({
    runId,
    status: 'interrupted',
    reason: error instanceof Error ? error.message : String(error || 'run_setup_failed')
  })
  return true
}

/** AgentTurnOutcome 到 durable terminal 的唯一通用对账。 */
export function reconcileAgentTurnTerminal(
  coordinator: RunTerminalPort,
  runId: string,
  outcome: AgentTurnOutcome
): void {
  const snapshot = coordinator.getSnapshot(runId)
  if (!snapshot) return
  if (
    isTerminalRunStatus(snapshot.status) ||
    snapshot.status === 'waiting_user'
  ) {
    return
  }
  if (outcome.status === 'failed') {
    coordinator.commitTerminal({
      runId,
      status: 'failed',
      reason: outcome.error.message
    })
    return
  }
  coordinator.commitTerminal({
    runId,
    status:
      outcome.status === 'cancelled' || snapshot.status === 'cancelling'
        ? 'cancelled'
        : 'completed',
    // incomplete 故意落入 completed：轮次确实结束了，incomplete 是轮次级语义
    // （停止策略截断），不扩展 durable run 状态枚举；截断原因单独落字段，
    // 供子代理结果投影层如实报告。cancelled 分支不携带（取消优先于截断）。
    ...(outcome.status === 'incomplete' ? { incompleteReason: outcome.reason } : {})
  })
}

export interface AgentTurnRunRefs {
  runId: string
  resourceOwnerRunId: string
  executionGeneration: number
}

export interface AgentTurnExecutionContext extends AgentTurnRunRefs {
  snapshot: RunSnapshot
}

export interface AgentTurnExecutorInput {
  readonly agentLoop: AgentLoop
  readonly task: string | ContentBlock[]
  readonly route: AgentTurnRoute
  readonly sessionId: string
  readonly workingDirectory: string
  readonly isolation: 'shared' | 'readonly'
  readonly invocationRef?: ToolInvocationRef
  readonly profile?: SubagentProfileSnapshot
  readonly runId?: string
  readonly resourceOwnerRunId?: string
  readonly resourceOwnerGeneration?: number
  readonly runRefs?: AgentTurnRunRefs
  readonly onStarted?: (context: AgentTurnExecutionContext) => void
  readonly afterOutcome?: (
    outcome: AgentTurnOutcome,
    context: AgentTurnExecutionContext
  ) => void | Promise<void>
  readonly onCleanup?: (context: AgentTurnExecutionContext) => void | Promise<void>
}

export interface AgentTurnExecutorResult extends AgentTurnExecutionContext {
  outcome: AgentTurnOutcome
}

/**
 * 普通 turn 与 delegated turn 共用的 run 执行生命周期。
 * 它不决定 profile、消息持久化、事件展示或子代理产品语义。
 */
export class AgentTurnExecutor {
  constructor(
    private readonly runCoordinator: RunCoordinator,
    private readonly executionRegistry: RunExecutionRegistry
  ) {}

  async execute(input: AgentTurnExecutorInput): Promise<AgentTurnExecutorResult> {
    let context: AgentTurnExecutionContext | null = null
    let resolveSettled = (): void => {}
    let registered = false
    let startedRunId: string | null = null

    try {
      const snapshot = this.runCoordinator.startRun({
        kind: 'agent',
        workspaceId: input.workingDirectory,
        sessionId: input.sessionId,
        ...(input.runId ? { runId: input.runId } : {})
      })
      if (
        snapshot.sessionId !== input.sessionId ||
        snapshot.workspaceId !== input.workingDirectory
      ) {
        throw new Error(`run ${snapshot.runId} 的 session/workspace identity 冲突`)
      }
      if (isTerminalRunStatus(snapshot.status)) {
        throw new Error(`run ${snapshot.runId} 已进入终态 ${snapshot.status}`)
      }

      startedRunId = snapshot.runId
      const resourceOwnerRunId = input.resourceOwnerRunId ?? snapshot.runId
      const executionGeneration = Math.max(
        Date.now(),
        (snapshot.executionGeneration ?? 0) + 1
      )
      context = {
        snapshot,
        runId: snapshot.runId,
        resourceOwnerRunId,
        executionGeneration
      }
      if (input.runRefs) {
        input.runRefs.runId = context.runId
        input.runRefs.resourceOwnerRunId = context.resourceOwnerRunId
        input.runRefs.executionGeneration = context.executionGeneration
      }

      input.agentLoop.setExecutionIdentity({
        runId: context.runId,
        resourceOwnerRunId: context.resourceOwnerRunId
      })
      input.agentLoop.setExecutionFence(() => {
        if (
          !this.runCoordinator.isExecutionCurrent(
            context!.runId,
            context!.executionGeneration
          )
        ) {
          return false
        }
        if (context!.resourceOwnerRunId === context!.runId) return true
        return (
          input.resourceOwnerGeneration !== undefined &&
          this.runCoordinator.isExecutionCurrent(
            context!.resourceOwnerRunId,
            input.resourceOwnerGeneration
          )
        )
      })

      const settled = new Promise<void>((resolve) => {
        resolveSettled = resolve
      })
      this.executionRegistry.register({
        runId: context.runId,
        generation: context.executionGeneration,
        kind: snapshot.kind,
        abort: () => input.agentLoop.cancel(),
        settled
      })
      registered = true
      this.runCoordinator.bindExecutionGeneration(
        context.runId,
        context.executionGeneration
      )
      input.onStarted?.(context)
      if (this.runCoordinator.getSnapshot(context.runId)?.status !== 'running') {
        this.runCoordinator.markRunning(context.runId)
      }

      const outcome = await input.agentLoop.sendMessage(input.task, input.route)
      await input.afterOutcome?.(outcome, context)

      try {
        reconcileAgentTurnTerminal(this.runCoordinator, context.runId, outcome)
      } catch (error) {
        console.error('[AgentTurnExecutor] terminal 提交失败:', error)
      }
      return { ...context, outcome }
    } catch (error) {
      try {
        interruptAgentTurnAfterFailure(this.runCoordinator, startedRunId, error)
      } catch (terminalError) {
        console.error('[AgentTurnExecutor] 异常收敛提交失败:', terminalError)
      }
      throw error
    } finally {
      resolveSettled()
      if (registered && context) {
        this.executionRegistry.unregister(
          context.runId,
          context.executionGeneration
        )
      }
      if (context) await input.onCleanup?.(context)
    }
  }
}
