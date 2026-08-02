import type {
  SpawnSubagentCommand,
  SubagentExecutionResult
} from '../../shared/subagents'
import type { ToolInvocationRef } from '../tools/types'

export interface SpawnSubagentContext {
  readonly invocationRef?: ToolInvocationRef
  readonly abortSignal?: AbortSignal
  /** Workflow 批次可进入有界 FIFO；普通 task 达到上限时立即得到结构化拒绝。 */
  readonly waitForPermit?: boolean
}

/** Stable consumer port for task today and Workflow after its dedicated migration. */
export interface SpawnSubagentPort {
  spawn(
    command: SpawnSubagentCommand,
    context?: SpawnSubagentContext
  ): Promise<SubagentExecutionResult>
}
