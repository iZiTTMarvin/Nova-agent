import type {
  FollowupSubagentCommand,
  SpawnSubagentCommand,
  SubagentExecutionResult
} from '../../shared/subagents'
import type { ToolInvocationRef } from '../tools/types'

export interface SpawnSubagentContext {
  readonly invocationRef?: ToolInvocationRef
  /** 仅内部消费者可提供；ExecutionService 仍会以 unknown 在边界校验并冻结。 */
  readonly profile?: unknown
  readonly abortSignal?: AbortSignal
  readonly waitForCapacity?: boolean
}

/** Stable consumer port for task and skill_fork child executions. */
export interface SpawnSubagentPort {
  spawn(
    command: SpawnSubagentCommand,
    context?: SpawnSubagentContext
  ): Promise<SubagentExecutionResult>

  /** 追加执行不携带 profile/isolation 等派遣输入，一切沿用既有子会话冻结值。 */
  followup(
    command: FollowupSubagentCommand,
    context?: SpawnSubagentContext
  ): Promise<SubagentExecutionResult>
}
