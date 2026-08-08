import { describe, expect, it } from 'vitest'
import type {
  SpawnSubagentCommand,
  SubagentActivityProjection,
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
  it('barrel supports explicit spawn command contracts without a loose payload', () => {
    const command: SpawnSubagentCommand = {
      parentSessionId: metadata.lineage.parentSessionId,
      parentRunId: metadata.lineage.parentRunId,
      invocation: metadata.lineage.origin,
      profileId: profile.profileId,
      task: 'Inspect persistence boundaries',
      workingDirectory: 'D:/workspace',
      isolation: 'readonly'
    }

    expect(command.isolation).toBe('readonly')
    expect(command.invocation).toEqual(metadata.lineage.origin)
  })

  it('activity projection exposes only render-safe, derived fields', () => {
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

    expect(activity).not.toHaveProperty('systemPrompt')
    expect(activity.profile).not.toHaveProperty('systemPrompt')
    expect(activity.parentToolCallId).toBe('tc_parent')
  })
})
