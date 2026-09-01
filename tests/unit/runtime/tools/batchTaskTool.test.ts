import { describe, expect, it, vi } from 'vitest'
import type { SpawnSubagentPort } from '../../../../src/runtime/subagents'
import { createReadState } from '../../../../src/runtime/tools/editTool'
import { createBatchTaskTool } from '../../../../src/runtime/tools/batch_task'
import type { ToolContext } from '../../../../src/runtime/tools/types'

const invocationRef = {
  sessionId: 'sess-parent',
  runId: 'run-parent',
  messageId: 'msg-parent',
  toolCallId: 'call-batch'
} as const

function context(abortSignal?: AbortSignal): ToolContext {
  return {
    workingDir: 'D:\\workspace',
    workspaceRoot: 'D:\\workspace',
    runId: invocationRef.runId,
    resourceOwnerRunId: invocationRef.runId,
    readState: createReadState(),
    invocationRef,
    ...(abortSignal ? { abortSignal } : {})
  }
}

describe('batch_task tool', () => {
  it('按当前工作区解析 profile，并要求执行服务等待容量', async () => {
    const profile = {
      id: 'project-review',
      name: 'project review',
      description: 'read only',
      allowedTools: ['read'],
      prompt: 'review',
      maxToolRounds: 10
    }
    const loadProfile = vi.fn((_profileId: string, _workspaceRoot: string) => profile)
    const spawn = vi.fn(async () => ({
      childSessionId: 'sess-child',
      childRunId: 'run-child',
      status: 'completed' as const,
      summary: 'done',
      artifactIds: [],
      startedAt: 1,
      completedAt: 2
    }))
    const tool = createBatchTaskTool({
      getSpawnSubagentPort: () => ({ spawn } as SpawnSubagentPort),
      loadProfile
    })

    const result = await tool.execute({
      items: [
        { itemId: 'first', profileId: 'project-review', task: 'check first' },
        { itemId: 'second', profileId: 'project-review', task: 'check second' }
      ]
    }, context())

    expect(result.success).toBe(true)
    expect(loadProfile).toHaveBeenCalledWith('project-review', 'D:\\workspace')
    expect(spawn).toHaveBeenCalledTimes(2)
    expect(spawn.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      profile,
      waitForCapacity: true
    }))
  })

  it.each(['incomplete', 'interrupted'] as const)('子项为 %s 时批次不报告成功', async (status) => {
    const profile = {
      id: 'review',
      name: 'review',
      description: 'read only',
      allowedTools: ['read'],
      prompt: 'review',
      maxToolRounds: 10
    }
    const spawn = vi.fn(async () => ({
      childSessionId: 'sess-child',
      childRunId: 'run-child',
      status,
      summary: 'partial',
      artifactIds: [],
      startedAt: 1,
      completedAt: 2
    }))
    const tool = createBatchTaskTool({
      getSpawnSubagentPort: () => ({ spawn } as SpawnSubagentPort),
      loadProfile: () => profile
    })

    const result = await tool.execute({
      items: [
        { itemId: 'first', profileId: 'review', task: 'check first' },
        { itemId: 'second', profileId: 'review', task: 'check second' }
      ]
    }, context())

    expect(result.success).toBe(false)
    expect(result.error).toContain(`first:${status}`)
  })

  it('父取消传播到所有未完成项，并保留已完成结果', async () => {
    const profile = {
      id: 'review',
      name: 'review',
      description: 'read only',
      allowedTools: ['read'],
      prompt: 'review',
      maxToolRounds: 10
    }
    const spawn = vi.fn<SpawnSubagentPort['spawn']>(async (command, spawnContext) => {
      if (command.task === 'finish first') {
        return {
          childSessionId: 'sess-first',
          childRunId: 'run-first',
          status: 'completed',
          summary: 'done',
          artifactIds: [],
          startedAt: 1,
          completedAt: 2
        }
      }
      return await new Promise((resolve) => {
        spawnContext?.abortSignal?.addEventListener('abort', () => resolve({
          childSessionId: 'sess-second',
          childRunId: 'run-second',
          status: 'cancelled',
          summary: 'cancelled',
          artifactIds: [],
          startedAt: 1,
          completedAt: 3
        }), { once: true })
      })
    })
    const tool = createBatchTaskTool({
      getSpawnSubagentPort: () => ({ spawn }),
      loadProfile: () => profile
    })
    const controller = new AbortController()

    const execution = tool.execute({
      items: [
        { itemId: 'first', profileId: 'review', task: 'finish first' },
        { itemId: 'second', profileId: 'review', task: 'wait second' }
      ]
    }, context(controller.signal))
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2))
    controller.abort()
    const result = await execution

    expect(result.success).toBe(false)
    expect(result.output).toContain('"itemId": "first"')
    expect(result.output).toContain('"status": "completed"')
    expect(result.output).toContain('"itemId": "second"')
    expect(result.output).toContain('"status": "cancelled"')
  })
})
