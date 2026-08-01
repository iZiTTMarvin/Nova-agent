import { describe, expect, it } from 'vitest'
import type {
  JsonSchema,
  SpawnSubagentCommand,
  SubagentActivityProjection,
  SubagentBatchProjection,
  SubagentProfileSnapshot,
  SubagentSessionMetadata
} from '../../../../src/shared/subagents'

const profile: SubagentProfileSnapshot = {
  profileId: 'explore',
  name: 'Explore',
  description: 'Read-only inspection',
  systemPrompt: 'This durable prompt must remain private to the child session.',
  toolNames: ['read', 'grep'],
  permissionCeiling: 'read_only',
  maxToolRounds: 20,
  configHash: 'hash-1'
}

const metadata: SubagentSessionMetadata = {
  lineage: {
    parentSessionId: 'sess_parent',
    parentRunId: 'run_parent',
    rootRunId: 'run_root',
    depth: 1,
    spawnKey: 'spawn-key',
    spawnRunId: 'run_child',
    origin: {
      kind: 'task_tool',
      parentMessageId: 'msg_parent',
      parentToolCallId: 'tc_parent'
    }
  },
  profile
}

describe('shared subagent contracts', () => {
  it('barrel supports explicit command/schema contracts without a loose payload', () => {
    const resultSchema: JsonSchema = {
      type: 'object',
      properties: {
        findings: {
          type: 'array',
          items: { type: 'string' }
        }
      },
      required: ['findings'],
      additionalProperties: false
    }
    const command: SpawnSubagentCommand = {
      parentSessionId: metadata.lineage.parentSessionId,
      parentRunId: metadata.lineage.parentRunId,
      invocation: metadata.lineage.origin,
      profileId: profile.profileId,
      task: 'Inspect persistence boundaries',
      workingDirectory: 'D:/workspace',
      isolation: 'readonly',
      resultSchema
    }

    expect(command.resultSchema).toEqual(resultSchema)
    expect(command.invocation).toEqual(metadata.lineage.origin)
  })

  it('activity and batch projections expose only render-safe, derived fields', () => {
    const activity: SubagentActivityProjection = {
      childSessionId: 'sess_child',
      childRunId: metadata.lineage.spawnRunId,
      parentSessionId: metadata.lineage.parentSessionId,
      parentToolCallId: metadata.lineage.origin.kind === 'task_tool'
        ? metadata.lineage.origin.parentToolCallId
        : undefined,
      profile: {
        profileId: profile.profileId,
        name: profile.name,
        permissionCeiling: profile.permissionCeiling
      },
      status: 'completed',
      startedAt: 1,
      completedAt: 2,
      summary: 'Found the durable owner.',
      artifactCount: 0
    }
    const batch: SubagentBatchProjection = {
      batchId: 'batch-1',
      parentSessionId: metadata.lineage.parentSessionId,
      status: 'completed',
      members: [{
        childSessionId: activity.childSessionId,
        childRunId: activity.childRunId,
        profileName: activity.profile.name,
        status: activity.status
      }]
    }

    expect(activity).not.toHaveProperty('systemPrompt')
    expect(activity.profile).not.toHaveProperty('systemPrompt')
    expect(batch.members).toEqual([{
      childSessionId: 'sess_child',
      childRunId: 'run_child',
      profileName: 'Explore',
      status: 'completed'
    }])
  })
})
