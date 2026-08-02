/**
 * Subagent cross-layer contracts.
 *
 * These DTOs describe durable identities and read-only execution facts. They
 * intentionally do not depend on any runtime, main-process, or renderer type.
 */

/** JSON values accepted by the environment-neutral result-schema contract. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [propertyName: string]: JsonValue }

interface JsonSchemaBase {
  readonly $id?: string
  readonly $ref?: string
  readonly title?: string
  readonly description?: string
  readonly default?: JsonValue
  readonly const?: JsonValue
  readonly enum?: readonly JsonValue[]
}

export interface JsonSchemaNull extends JsonSchemaBase {
  readonly type: 'null'
}

export interface JsonSchemaBoolean extends JsonSchemaBase {
  readonly type: 'boolean'
}

export interface JsonSchemaNumber extends JsonSchemaBase {
  readonly type: 'number'
  readonly minimum?: number
  readonly maximum?: number
  readonly exclusiveMinimum?: number
  readonly exclusiveMaximum?: number
  readonly multipleOf?: number
}

export interface JsonSchemaInteger extends JsonSchemaBase {
  readonly type: 'integer'
  readonly minimum?: number
  readonly maximum?: number
  readonly exclusiveMinimum?: number
  readonly exclusiveMaximum?: number
  readonly multipleOf?: number
}

export interface JsonSchemaString extends JsonSchemaBase {
  readonly type: 'string'
  readonly minLength?: number
  readonly maxLength?: number
  readonly pattern?: string
  readonly format?: string
}

export interface JsonSchemaArray extends JsonSchemaBase {
  readonly type: 'array'
  readonly items?: JsonSchema
  readonly minItems?: number
  readonly maxItems?: number
  readonly uniqueItems?: boolean
}

export interface JsonSchemaObject extends JsonSchemaBase {
  readonly type: 'object'
  readonly properties?: { readonly [propertyName: string]: JsonSchema }
  readonly required?: readonly string[]
  readonly additionalProperties?: boolean | JsonSchema
  readonly minProperties?: number
  readonly maxProperties?: number
}

/**
 * A deliberately explicit recursive subset of JSON Schema suitable for
 * transport contracts. Boolean schemas remain valid JSON Schema values.
 */
export type JsonSchema =
  | boolean
  | JsonSchemaNull
  | JsonSchemaBoolean
  | JsonSchemaNumber
  | JsonSchemaInteger
  | JsonSchemaString
  | JsonSchemaArray
  | JsonSchemaObject

/** The caller category that gives a child execution its durable identity. */
export type SubagentOrigin =
  | {
      readonly kind: 'task_tool'
      readonly parentMessageId: string
      readonly parentToolCallId: string
    }
  | {
      readonly kind: 'workflow'
      readonly workflowRunId: string
      readonly phase: string
      readonly taskId?: string
      readonly batchId?: string
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
  readonly isolation: 'shared' | 'readonly' | 'worktree'
  readonly resultSchema?: JsonSchema
  readonly timeoutMs?: number
}

export type SubagentExecutionStatus =
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'

export type SubagentFailureCode =
  | 'model'
  | 'tool'
  | 'timeout'
  | 'permission'
  | 'schema'
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
}
