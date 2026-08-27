/**
 * Read-only UI DTOs derived from durable sessions and run snapshots.
 * They never contain a profile system prompt and are not a state source.
 */

import type { ReasoningEffort } from '../config/llmRegistry'
import type { DiffEntry } from '../diff/types'
import type { RunStatus } from '../run/types'
import type {
  SubagentExecutionFailure,
  SubagentModelSnapshot,
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

/**
 * 会话级聚合的单文件净变化（已与当前工作区对比）。
 * 行数由 DiffEntry hunks 统计而来，仅展示语义。
 */
export interface SubagentFileChange {
  readonly filePath: string
  /** 与 DiffEntry 同一判别联合，不另起第二份状态词汇 */
  readonly status: DiffEntry['status']
  readonly addedLines: number
  readonly removedLines: number
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
  /**
   * 历史编排子代理的只读溯源字段。
   * 删除条件：同 SubagentOrigin.kind=workflow。
   * 保护：仅由投影从已持久化 lineage 填充，执行层不得再写入。
   */
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
  /** 子代理实际生效模型；仅从 child SessionHeader 投影，旧会话无法推导时省略。 */
  readonly model?: SubagentModelSnapshot
  /** child SessionHeader 冻结的有效思考强度。 */
  readonly reasoningEffort?: ReasoningEffort
  /**
   * 终态且存在 checkpoint 改动时输出会话级聚合的净文件变化。
   * 只读子代理无写入工具，恒缺省；UI 据此不渲染 diff 卡。
   */
  readonly fileChanges?: readonly SubagentFileChange[]
}
