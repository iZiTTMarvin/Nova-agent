import type {
  SessionKind,
  SpawnSubagentCommand,
  SubagentActivityProjection,
  SubagentActivityStatus,
  SubagentExecutionResult,
  SubagentLineage,
  SubagentOrigin,
  SubagentProfileSnapshot,
  SubagentSessionMetadata
} from './index'
import type { RunStatus } from '../run/types'

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2)
    ? true
    : false

type Assert<Condition extends true> = Condition
type IsAny<Value> = 0 extends 1 & Value ? true : false
type IsNotAny<Value> = Equal<IsAny<Value>, false>
type IsLooseUnknownRecord<Value> =
  Value extends Record<string, unknown>
    ? string extends keyof Value
      ? true
      : false
    : false

type PublicContractsRemainExplicit = [
  Assert<IsNotAny<SubagentOrigin>>,
  Assert<IsNotAny<SubagentLineage>>,
  Assert<IsNotAny<SubagentProfileSnapshot>>,
  Assert<IsNotAny<SubagentSessionMetadata>>,
  Assert<IsNotAny<SpawnSubagentCommand>>,
  Assert<IsNotAny<SubagentExecutionResult>>,
  Assert<IsNotAny<SubagentActivityProjection>>,
  Assert<Equal<SessionKind, 'primary' | 'subagent'>>,
  Assert<Equal<Extract<SubagentOrigin, { kind: 'task_tool' }>['parentToolCallId'], string>>,
  Assert<Equal<Extract<SubagentOrigin, { kind: 'workflow' }>['workflowRunId'], string>>,
  Assert<Equal<'systemPrompt' extends keyof SubagentActivityProjection ? true : false, false>>,
  Assert<Equal<Exclude<RunStatus, SubagentActivityStatus>, never>>,
  Assert<Equal<'record_missing' extends SubagentActivityStatus ? true : false, true>>,
  Assert<IsNotAny<SubagentLineage['origin']>>,
  Assert<IsNotAny<SubagentProfileSnapshot['toolNames'][number]>>,
  Assert<IsNotAny<SubagentActivityProjection['profile']>>,
  Assert<Equal<
    SubagentProfileSnapshot extends SubagentActivityProjection['profile'] ? true : false,
    false
  >>,
  Assert<Equal<IsLooseUnknownRecord<SubagentOrigin>, false>>,
  Assert<Equal<IsLooseUnknownRecord<SubagentLineage>, false>>,
  Assert<Equal<IsLooseUnknownRecord<SpawnSubagentCommand>, false>>,
  Assert<Equal<IsLooseUnknownRecord<SubagentExecutionResult>, false>>,
  Assert<Equal<IsLooseUnknownRecord<SubagentActivityProjection>, false>>,
  Assert<Equal<SpawnSubagentCommand['isolation'], 'shared' | 'readonly'>>
]

export type SubagentContractTypeAssertions = PublicContractsRemainExplicit
