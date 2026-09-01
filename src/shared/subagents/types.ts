/**
 * Subagent cross-layer contracts.
 *
 * These DTOs describe durable identities and read-only execution facts. They
 * intentionally do not depend on any runtime, main-process, or renderer type.
 */
import type { TurnTruncationReason } from '../run/types'
import type { ReasoningEffort } from '../config'

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

/** Preset model binding; modelEntryId is the registry-owned stable identity. */
export interface SubagentModelBinding {
  readonly providerId: string
  readonly modelEntryId: string
  /** 缺省时使用 registry entry 的默认值，派生时写入 header 的有效值。 */
  readonly reasoningEffort?: ReasoningEffort
}

/**
 * 旧 profile 的只读模型引用；不可用于新执行。
 * 删除条件：所有持久化 profile 完成重新绑定后，且迁移不再读取 modelId 形状。
 */
export type LegacySubagentModelReference = SubagentModelSnapshot

export type SubagentProfileModel = SubagentModelBinding | LegacySubagentModelReference

/**
 * Child Session 的最小模型事实。
 * 能力、缓存和凭据不落盘，恢复时按同一 registry entry 解析。
 */
export interface SubagentSessionHeader {
  readonly providerId: string
  readonly modelEntryId: string
  /** 创建时看到的公开 API model ID；entry 漂移时恢复必须失败。 */
  readonly modelId: string
  readonly reasoningEffort: ReasoningEffort
}

export type SubagentCatalogReason =
  | 'provider_missing'
  | 'provider_disabled'
  | 'credentials_missing'
  | 'model_missing'
  | 'model_retired'
  | 'model_invalid'
  | 'legacy_model_binding'

export interface SubagentCatalogModel {
  readonly providerId: string
  readonly modelEntryId?: string
  readonly modelId?: string
  readonly reasoningEffort?: ReasoningEffort
}

/** agent_list 只读展示项，不含 prompt、凭据或运行时配置。 */
export interface SubagentCatalogEntry {
  /** 稳定派遣身份；模型以此派遣，显示名重命名不影响它。 */
  readonly profileId: string
  /** 展示名，可修改。 */
  readonly name: string
  readonly description: string
  readonly status: 'available' | 'unavailable'
  readonly reason?: SubagentCatalogReason
  readonly model?: SubagentCatalogModel
}

/** Frozen profile used to make a historical child run interpretable. */
export interface SubagentProfileSnapshot {
  /** 冻结时刻的稳定 preset/内置/skill 身份。 */
  readonly profileId: string
  /** 冻结时刻的展示名；历史快照不随后续重命名漂移。 */
  readonly name: string
  readonly description: string
  readonly systemPrompt: string
  readonly toolNames: readonly string[]
  readonly permissionCeiling: 'read_only' | 'workspace_write'
  readonly model?: SubagentProfileModel
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
  /** 新建 child 必须存在；历史会话可缺省且不能据此猜测实际模型。 */
  readonly header?: SubagentSessionHeader
}

/** Intent submitted to the future subagent execution owner. */
export interface SpawnSubagentCommand {
  readonly parentSessionId: string
  readonly parentRunId: string
  readonly invocation: SubagentOrigin
  /** 稳定 profile/preset ID（内置 ID 为保留字），不是可改的显示名。 */
  readonly profileId: string
  readonly task: string
  readonly workingDirectory: string
  readonly isolation: 'shared' | 'readonly'
  readonly timeoutMs?: number
  /** 可选 canonical 模型覆盖；只影响模型路由，不改变 profile prompt/工具/权限/isolation。 */
  readonly modelOverride?: {
    readonly providerId: string
    readonly modelEntryId: string
  }
  readonly reasoningEffort?: ReasoningEffort
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
