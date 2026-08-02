/**
 * Read-only UI DTOs derived from durable sessions and run snapshots.
 * They never contain a profile system prompt and are not a state source.
 */

import type { RunStatus } from '../run/types'
import type {
  SubagentExecutionFailure,
  SubagentProfileSnapshot
} from './types'

/** Run 状态的只读投影；记录缺失不是伪造的 run 终态。 */
export type SubagentActivityStatus = RunStatus | 'record_missing'

/** 可渲染的窄 profile；never 字段阻止把完整持久化快照直接塞进 IPC DTO。 */
export interface SubagentProfileProjection {
  readonly profileId: string
  readonly name: string
  readonly permissionCeiling: SubagentProfileSnapshot['permissionCeiling']
  readonly systemPrompt?: never
  readonly toolNames?: never
  readonly model?: never
  readonly maxToolRounds?: never
  readonly configHash?: never
}

/** Child-session metadata safe for session lists and renderer navigation. */
export interface SubagentSessionListMetadata {
  readonly lineage: {
    readonly parentSessionId: string
    readonly depth: number
  }
  readonly profile: SubagentProfileProjection
}

/**
 * One child execution as shown from its parent message or the session tree.
 * The projection joins existing owners; consumers must never write it back.
 */
export interface SubagentActivityProjection {
  readonly childSessionId: string
  readonly childRunId: string
  readonly parentSessionId: string
  readonly parentToolCallId?: string
  readonly workflow?: {
    readonly workflowRunId: string
    readonly phase: string
    readonly taskId?: string
    readonly batchId?: string
    readonly occurrence: number
  }
  readonly profile: SubagentProfileProjection
  readonly taskLabel: string
  readonly status: SubagentActivityStatus
  /** 对应 RunSnapshot 的单调序号；record_missing 时省略。 */
  readonly sequence?: number
  readonly startedAt?: number
  readonly completedAt?: number
  readonly latestActivity?: string
  readonly summary?: string
  readonly artifactCount: number
  readonly failure?: SubagentExecutionFailure
}

export type SubagentBatchStatus =
  | 'running'
  | 'completed'
  | 'partial'
  | 'failed'
  | 'cancelled'

/** Compact batch member shape for the parallel activity row. */
export interface SubagentBatchMemberProjection {
  readonly childSessionId: string
  readonly childRunId: string
  readonly profileName: string
  readonly status: SubagentActivityStatus
}

/** Derived aggregate for a parallel group; member runs remain the status owners. */
export interface SubagentBatchProjection {
  readonly batchId: string
  readonly parentSessionId: string
  readonly status: SubagentBatchStatus
  readonly members: readonly SubagentBatchMemberProjection[]
}
