/**
 * 编排控制器的对外契约。
 *
 * run 生命周期状态的唯一 Owner 是 orchestrator：调用方只能通过 start / cancel / getStatus
 * 读取或请求变更，不得自己维护一份并行的 run 状态。
 */
import type { EventBus } from '../../agent/EventBus'
import type { CheckpointManager } from '../../checkpoints/CheckpointManager'
import type { Mode } from '../../../shared/session/types'
import type { WorkflowRunStatus } from '../../../shared/workflow/types'
import type { WorkflowDefinition } from '../definitions/types'
import type { SpawnSubagentPort } from '../../subagents'

export type { WorkflowRunStatus }

/** 对外可查询的 run 摘要（不含 TaskScope / HostContext 等内部句柄） */
export interface WorkflowRunSnapshot {
  runId: string
  workflow: string
  sessionId?: string
  status: WorkflowRunStatus
  /** 当前阶段名，由 host.progress('x', 'started') 推进 */
  phase: string
  startedAt: string
  updatedAt: string
  /** 仅 failed 时存在 */
  error?: string
}

export type WorkflowRunOutcome =
  | { status: 'completed'; runId: string; summary: string; result?: unknown }
  | { status: 'failed'; runId: string; error: string }
  | { status: 'cancelled'; runId: string }

/**
 * 单次 run 的宿主装配依赖。
 *
 * 这些引用天然是「每轮 turn 一份」（eventBus / modelClient / 权限桥都绑定当前 turn），
 * 因此随 start() 传入，而不是挂在 orchestrator 上长期持有。
 */
export interface WorkflowHostDeps {
  workspaceRoot: string
  sessionId: string
  parentRunId: string
  parentMessageId: string
  parentToolCallId: string
  spawnSubagentPort: SpawnSubagentPort
  eventBus: EventBus
  checkpointManager?: CheckpointManager
  supportsVision?: boolean
  /** 子 agent 行为模式，编排内默认 compose */
  mode?: Mode
  /** 父 Agent run 的 execution generation fencing，与 TaskScope 叠加 */
  assertExecutionCurrent?: () => boolean
}

export interface StartWorkflowOptions {
  /** definition 名称，由 resolveDefinition 解析 */
  workflow: string
  startStage: string
  request: string
  host: WorkflowHostDeps
  injectedContext?: Record<string, unknown>
  /** Auto 模式：true 时全程不弹提问面板 */
  autoMode?: boolean
  /** 指定 runId（resume 用）；缺省自动生成 */
  runId?: string
  /** 墙钟预算，到期真正 abort scope */
  deadlineMs?: number
  /**
   * 外部取消信号（停止按钮 / AgentLoop abort）。
   * 触发后等价于 cancel(runId)，让取消能穿透到 TaskScope.close。
   */
  abortSignal?: AbortSignal
  /** TaskScope 关闭后等待子任务收敛的宽限期 */
  graceMs?: number
}

/** definition 解析器：orchestrator 不持有注册表实现 */
export type ResolveWorkflowDefinition = (name: string) => WorkflowDefinition | undefined

export interface WorkflowOrchestratorDeps {
  resolveDefinition: ResolveWorkflowDefinition
}
