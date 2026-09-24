import { createHash } from 'node:crypto'
import type { FollowupSubagentCommand, SpawnSubagentCommand } from '../../shared/subagents'

export interface SpawnIdentity {
  readonly spawnKey: string
  readonly spawnRunId: string
}

function deriveSpawnRunId(spawnKey: string): string {
  const digest = createHash('sha256')
    .update(`spawn-run\0${spawnKey}`, 'utf8')
    .digest('hex')
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    digest.slice(12, 16),
    digest.slice(16, 20),
    digest.slice(20, 32)
  ].join('-')
}

function hashStableFields(stableFields: readonly string[]): string {
  return createHash('sha256')
    .update(stableFields.join('\0'), 'utf8')
    .digest('hex')
}

function createStableSpawnKey(command: SpawnSubagentCommand): string {
  const origin = command.invocation
  const stableFields =
    origin.kind === 'task_tool'
      ? ['task_tool', command.parentRunId, origin.parentMessageId, origin.parentToolCallId]
      : origin.kind === 'skill_fork'
        ? [
            'skill_fork',
            command.parentRunId,
            origin.parentMessageId,
            origin.parentToolCallId ?? '',
            origin.skillName
          ]
        : [
            'workflow',
            origin.workflowRunId,
            origin.phase,
            origin.taskId ?? '',
            origin.batchId ?? '',
            String(origin.occurrence ?? 0)
          ]
  return `${origin.kind}:${hashStableFields(stableFields)}`
}

/**
 * Derive spawn identity for a task_tool invocation.
 * Use the Pick<> subset for settlement callers that only have parentRunId + invocation.
 */
export function createSpawnIdentity(
  command: Pick<SpawnSubagentCommand, 'parentRunId' | 'invocation'>
): SpawnIdentity {
  const spawnKey = createStableSpawnKey(command as SpawnSubagentCommand)
  return { spawnKey, spawnRunId: deriveSpawnRunId(spawnKey) }
}

/**
 * Derive spawn identity for a task_followup invocation.
 */
export function deriveFollowupUserMessageId(spawnKey: string): string {
  const digest = createHash('sha256')
    .update(`followup-task\0${spawnKey}`, 'utf8')
    .digest('hex')
  return `msg_sub_user_${digest.slice(0, 32)}`
}

export function createFollowupSpawnIdentity(
  command: Pick<
    FollowupSubagentCommand,
    'parentRunId' | 'parentMessageId' | 'parentToolCallId' | 'previousChildSessionId'
  >
): SpawnIdentity {
  const spawnKey = `task_followup:${hashStableFields([
    'task_followup',
    command.parentRunId,
    command.parentMessageId,
    command.parentToolCallId,
    command.previousChildSessionId
  ])}`
  return { spawnKey, spawnRunId: deriveSpawnRunId(spawnKey) }
}

import type { BatchSubagentItem } from '../../shared/subagents'

/**
 * Deterministic digest of batch items for stable child identity.
 * Matches the algorithm in batch_task/index.ts (byte-for-byte).
 */
export function computeBatchItemDigest(items: readonly BatchSubagentItem[]): string {
  return createHash('sha256')
    .update(items.map(e => `${e.itemId}\0${e.profileId}\0${e.task}`).join('\0'))
    .digest('hex')
    .slice(0, 8)
}

/**
 * Derive tool call id for a single batch item, unique within a batch_task call.
 */
export function deriveBatchItemToolCallId(
  parentToolCallId: string,
  batchDigest: string,
  itemId: string
): string {
  return `${parentToolCallId}:batch:${batchDigest}:${itemId}`
}
