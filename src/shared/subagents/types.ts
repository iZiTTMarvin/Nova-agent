/**
 * Subagent cross-layer contracts.
 *
 * These DTOs describe durable identities and read-only execution facts. They
 * intentionally do not depend on any runtime, main-process, or renderer type.
 */
import type { TurnTruncationReason } from '../run/types'

/** The caller category that gives a child execution its durable identity. */
export type SubagentOrigin =
  | {
      readonly kind: 'task_tool'
      readonly parentMessageId: string
      readonly parentToolCallId: string
    }
  | {
      /**
       * 历史编排子代理身份（只读兼容）。
       * 删除条件：仓库内不再存在任何 kind=workflow 的持久化子会话，且 migrations 不再需要解析该变体。
       * 保护：新 spawn 必须被执行层拒绝；仅 load/migrate/投影可读。
       */
      readonly kind: 'workflow'
      readonly workflowRunId: string
      readonly phase: string
      readonly parentMessageId: string
      readonly parentToolCallId: string
      readonly occurrence?: number
      readonly taskId?: string
      readonly batchId?: string
    }
  | {
      readonly kind: 'skill_fork'
      readonly parentMessageId: string
      /** invoke_skill 触发时保留真实 toolCallId；slash fork 无此字段。 */
      readonly parentToolCallId?: string
      readonly skillName: string
    }

/** Stable parent-child identity, persisted with a child session. */
export interface SubagentLineage {
  readonly parentSessionId: string
  readonly parentRunId: string
  readonly rootRunId: string
  readonly depth: number
  readonly spawnKey: string
  readonly spawnRunId: string
  readonly origin: SubagentOrigin
}

export interface SubagentModelSnapshot {
  readonly providerId: string
  readonly modelId: string
}

/** Frozen profile used to make a historical child run interpretable. */
export interface SubagentProfileSnapshot {
  readonly profileId: string
  readonly name: string
  readonly description: string
  readonly systemPrompt: string
  readonly toolNames: readonly string[]
  readonly permissionCeiling: 'read_only' | 'workspace_write'
  readonly model?: SubagentModelSnapshot
  readonly maxToolRounds: number
  readonly contextWindow?: number
  /** 仅 skill_fork 可用的持久化只读根，用于加载 skill references。 */
  readonly skillRoots?: readonly string[]
  readonly configHash: string
}

export type SessionKind = 'primary' | 'subagent'

/** Durable metadata required by every session whose kind is `subagent`. */
export interface SubagentSessionMetadata {
  readonly lineage: SubagentLineage
  readonly profile: SubagentProfileSnapshot
}

/** Intent submitted to the future subagent execution owner. */
export interface SpawnSubagentCommand {
  readonly parentSessionId: string
  readonly parentRunId: string
  readonly invocation: SubagentOrigin
  readonly profileId: string
  readonly task: string
  readonly workingDirectory: string
  readonly isolation: 'shared' | 'readonly'
  readonly timeoutMs?: number
}

export type SubagentExecutionStatus =
  | 'completed'
  | 'incomplete'
  | 'failed'
  | 'cancelled'
  | 'interrupted'

export type SubagentFailureCode =
  | 'model'
  | 'tool'
  | 'timeout'
  | 'permission'
  | 'schema'
  | 'scheduler'
  | 'host'

export interface SubagentExecutionFailure {
  readonly code: SubagentFailureCode
  readonly message: string
}

/** Bounded child result returned to a caller; full evidence remains in the child session. */
export interface SubagentExecutionResult {
  readonly childSessionId: string
  readonly childRunId: string
  readonly status: SubagentExecutionStatus
  readonly summary: string
  readonly artifactIds: readonly string[]
  readonly startedAt: number
  readonly completedAt: number
  readonly failure?: SubagentExecutionFailure
  /** status === 'incomplete' 时的截断原因（源自 durable run 记录） */
  readonly incompleteReason?: TurnTruncationReason
}
