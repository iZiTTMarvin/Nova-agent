import { describe, expect, it, vi } from 'vitest'
import { AgentLoop } from '../../../src/runtime/agent/AgentLoop'
import { EventBus } from '../../../src/runtime/agent/EventBus'
import { MockModelClient } from '../../../src/test-support/builders/MockModelClient'
import { ToolRegistry } from '../../../src/runtime/tools/ToolRegistry'
import { createTaskTool } from '../../../src/runtime/tools/task'
import type { SpawnSubagentPort } from '../../../src/runtime/subagents'
import { agentRoute } from '../../../src/runtime/agent/turn'
import { PermissionManager } from '../../../src/runtime/permissions/PermissionManager'

function setupExploreE2E() {
  const client = new MockModelClient()
  client.addResponse({
    events: [
      { type: 'message_start' },
      {
        type: 'tool_call',
        toolCall: {
          id: 'tc1',
          name: 'task',
          arguments: JSON.stringify({
            subagent_type: 'explore',
            task: 'find TODOs'
          })
        }
      },
      { type: 'message_end', finishReason: 'tool_calls' }
    ]
  })
  client.addResponse({
    events: [
      { type: 'message_start' },
      { type: 'text_delta', delta: 'Summary received' },
      { type: 'message_end', finishReason: 'stop' }
    ]
  })

  const spawn = vi.fn(async () => ({
    childSessionId: 'sess_sub_child',
    childRunId: '11111111-2222-3333-4444-555555555555',
    status: 'completed' as const,
    summary: '3 TODO comments in src/runtime',
    artifactIds: [],
    startedAt: 1,
    completedAt: 2
  }))
  const port = { spawn } as SpawnSubagentPort
  const bus = new EventBus()
  const registry = new ToolRegistry()
  registry.register(createTaskTool({ getSpawnSubagentPort: () => port }))

  const loop = new AgentLoop(client, bus, { permissionManager: new PermissionManager() })
  loop.setToolRegistry(registry)
  loop.setWorkingDir(process.cwd())
  loop.setExecutionIdentity({
    runId: 'run-parent',
    resourceOwnerRunId: 'run-parent'
  })
  loop.setSessionContext({} as never, 'sess-parent')
  return { loop, spawn }
}

describe('subAgent parent-tool integration', () => {
  it('父 agent 调用 task port，tool_result 保持兼容摘要正文', async () => {
    const { loop, spawn } = setupExploreE2E()
    await loop.sendMessage('列出 TODO', agentRoute())

    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        parentSessionId: 'sess-parent',
        parentRunId: 'run-parent',
        invocation: expect.objectContaining({
          kind: 'task_tool',
          parentToolCallId: 'tc1'
        })
      }),
      expect.objectContaining({
        invocationRef: expect.objectContaining({
          sessionId: 'sess-parent',
          runId: 'run-parent',
          toolCallId: 'tc1'
        })
      })
    )
    const toolMessage = loop.getContext().find((message) => message.role === 'tool')
    expect(String(toolMessage?.content)).toContain('3 TODO comments in src/runtime')
    expect(String(toolMessage?.content)).toContain('[子代理 explore')
  })

  it('子代理摘要不污染父 assistant 文本，完整流程后父 loop idle', async () => {
    const { loop } = setupExploreE2E()
    await loop.sendMessage('调研', agentRoute())

    const assistantMessages = loop.getContext().filter((message) => message.role === 'assistant')
    const lastAssistant = assistantMessages.at(-1)
    expect(String(lastAssistant?.content)).not.toContain('3 TODO comments')
    expect(String(lastAssistant?.content)).toContain('Summary received')
    expect(loop.getState()).toBe('idle')
  })
})
