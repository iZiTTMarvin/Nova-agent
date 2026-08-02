import type {
  SpawnSubagentCommand,
  SubagentExecutionResult
} from '../../shared/subagents'
import type { ToolInvocationRef } from '../tools/types'

export interface SpawnSubagentContext {
  readonly invocationRef?: ToolInvocationRef
  readonly abortSignal?: AbortSignal
}

/** Stable consumer port for task today and Workflow after its dedicated migration. */
export interface SpawnSubagentPort {
  spawn(
    command: SpawnSubagentCommand,
    context?: SpawnSubagentContext
  ): Promise<SubagentExecutionResult>
}
