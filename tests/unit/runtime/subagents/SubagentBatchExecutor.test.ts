import { describe, expect, it, vi } from 'vitest'
import {
  createSpawnIdentity,
  executeSubagentBatch,
  type SpawnSubagentPort
} from '../../../../src/runtime/subagents'
import type { SpawnSubagentCommand } from '../../../../src/shared/subagents'

function command(task: string): SpawnSubagentCommand {
  return {
    parentSessionId: 'session-parent',
    parentRunId: 'run-parent',
    invocation: {
      kind: 'workflow',
      workflowRunId: 'workflow-run',
      phase: 'implement',
      parentMessageId: 'message-parent',
      parentToolCallId: 'tool-parent',
      occurrence: 0,
      batchId: 'batch-1'
    },
    profileId: 'code',
    task,
    workingDirectory: '/workspace',
    isolation: 'worktree'
  }
}

describe('executeSubagentBatch', () => {
  it('用稳定 itemKey 生成不同 spawn identity，resume 保持不变', async () => {
    const captured: SpawnSubagentCommand[] = []
    const port: SpawnSubagentPort = {
      spawn: vi.fn(async (input) => {
        captured.push(input)
        return {
          childSessionId: `session-${input.task}`,
          childRunId: createSpawnIdentity(input).spawnRunId,
          status: 'completed',
          summary: input.task,
          artifactIds: [],
          startedAt: 1,
          completedAt: 2
        }
      })
    }

    await executeSubagentBatch(port, [
      { itemKey: 'item-a', command: command('a') },
      { itemKey: 'item-b', command: command('b') }
    ])

    expect(captured.map((item) => item.invocation)).toEqual([
      expect.objectContaining({ taskId: 'item-a' }),
      expect.objectContaining({ taskId: 'item-b' })
    ])
    expect(createSpawnIdentity(captured[0]).spawnRunId)
      .toBe(createSpawnIdentity({ ...captured[0] }).spawnRunId)
    expect(createSpawnIdentity(captured[0]).spawnRunId)
      .not.toBe(createSpawnIdentity(captured[1]).spawnRunId)
  })

  it('partial batch 逐成员结算，单项失败不连坐', async () => {
    const port: SpawnSubagentPort = {
      spawn: vi.fn(async (input) => {
        if (input.task === 'bad') throw new Error('member failed')
        return {
          childSessionId: 'session-ok',
          childRunId: 'run-ok',
          status: 'completed',
          summary: 'ok',
          artifactIds: [],
          startedAt: 1,
          completedAt: 2
        }
      })
    }

    const result = await executeSubagentBatch(port, [
      { itemKey: 'ok', command: command('ok') },
      { itemKey: 'bad', command: command('bad') }
    ])

    expect(result).toEqual([
      expect.objectContaining({ itemKey: 'ok', status: 'fulfilled' }),
      expect.objectContaining({ itemKey: 'bad', status: 'rejected', error: 'member failed' })
    ])
  })
})
