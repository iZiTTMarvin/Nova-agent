import { describe, it, expect } from 'vitest'
import { AgentLoop } from '../../../src/runtime/agent/AgentLoop'
import { EventBus } from '../../../src/runtime/agent/EventBus'
import { MockModelClient } from '../../../src/test-support/builders/MockModelClient'
import { ToolRegistry } from '../../../src/runtime/tools/ToolRegistry'
import { createTaskTool } from '../../../src/runtime/tools/taskTool'
import type { ToolResult } from '../../../src/runtime/tools/types'

function setupExploreE2E() {
  const client = new MockModelClient()
  client.addResponse({
    events: [
      { type: 'message_start' },
      {
        type: 'tool_call',
        toolCall: { id: 'tc1', name: 'task', arguments: JSON.stringify({ subagent_type: 'explore', task: 'find TODOs' }) }
      },
      { type: 'message_end', finishReason: 'tool_calls' }
    ]
  })
  client.addResponse({
    events: [
      { type: 'message_start' },
      { type: 'text_delta', delta: '3 TODO comments in src/runtime' },
      { type: 'message_end', finishReason: 'stop' }
    ]
  })
  client.addResponse({
    events: [
      { type: 'message_start' },
      { type: 'text_delta', delta: 'Summary received' },
      { type: 'message_end', finishReason: 'stop' }
    ]
  })

  const bus = new EventBus()
  const reg = new ToolRegistry()
  reg.register({
    name: 'read',
    description: 'read',
    parameters: { type: 'object', properties: {} },
    async execute(): Promise<ToolResult> {
      return { success: true, output: 'file content' }
    }
  })
  reg.register(createTaskTool({
    modelClient: client,
    parentEventBus: bus,
    resolveTool: (n) => reg.getTool(n)
  }))

  const loop = new AgentLoop(client, bus)
  loop.setToolRegistry(reg)
  loop.setWorkingDir(process.cwd())
  return { loop, bus, client }
}

describe('subAgent end-to-end', () => {
  it('父 agent 调用 task 工具，tool_result 含子代理摘要正文', async () => {
    const { loop } = setupExploreE2E()
    await loop.sendMessage('列出 TODO')
    const toolMsg = loop.getContext().find(m => m.role === 'tool')
    expect(toolMsg).toBeDefined()
    expect(String(toolMsg?.content)).toContain('3 TODO comments in src/runtime')
    expect(String(toolMsg?.content)).toContain('[子代理 explore')
  })

  it('子代理摘要不污染父 assistant 文本', async () => {
    const { loop } = setupExploreE2E()
    await loop.sendMessage('调研')
    const assistantMsgs = loop.getContext().filter(m => m.role === 'assistant')
    const lastAssistant = assistantMsgs[assistantMsgs.length - 1]
    expect(String(lastAssistant?.content)).not.toContain('3 TODO comments')
    expect(String(lastAssistant?.content)).toContain('Summary received')
  })

  it('完整流程后父 agent 处于 idle', async () => {
    const { loop } = setupExploreE2E()
    await loop.sendMessage('go')
    expect(loop.getState()).toBe('idle')
  })
})
