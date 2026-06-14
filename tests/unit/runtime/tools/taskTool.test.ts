import { describe, it, expect } from 'vitest'
import { createTaskTool } from '../../../../src/runtime/tools/taskTool'
import { ToolRegistry } from '../../../../src/runtime/tools/ToolRegistry'
import { MockModelClient } from '../../../../src/test-support/builders/MockModelClient'
import { EventBus } from '../../../../src/runtime/agent/EventBus'
import { createReadState } from '../../../../src/runtime/tools/editTool'
import type { ToolContext, ToolResult } from '../../../../src/runtime/tools/types'
import { SUB_PERMISSION_PREFIX, SubAgentPermissionBridge } from '../../../../src/runtime/tools/subAgentBridge'

function baseRegistry(): ToolRegistry {
  const reg = new ToolRegistry()
  reg.register({
    name: 'ls',
    description: 'list',
    parameters: { type: 'object', properties: {} },
    async execute(): Promise<ToolResult> {
      return { success: true, output: 'files' }
    }
  })
  return reg
}

const ctx: ToolContext = { workingDir: process.cwd(), readState: createReadState() }

describe('taskTool', () => {
  it('未知子代理类型返回错误', async () => {
    const reg = baseRegistry()
    const tool = createTaskTool({
      modelClient: new MockModelClient(),
      parentEventBus: new EventBus(),
      resolveTool: (n) => reg.getTool(n)
    })
    const result = await tool.execute({ subagent_type: 'nope', task: 't' }, ctx)
    expect(result.success).toBe(false)
    expect(result.error).toContain('未知')
  })

  it('explore 子代理执行并返回摘要', async () => {
    const reg = baseRegistry()
    const client = new MockModelClient()
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'text_delta', delta: 'found todos' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })
    const tool = createTaskTool({
      modelClient: client,
      parentEventBus: new EventBus(),
      resolveTool: (n) => reg.getTool(n)
    })
    const result = await tool.execute({ subagent_type: 'explore', task: 'list files' }, ctx)
    expect(result.success).toBe(true)
    expect(result.output).toContain('found todos')
  })

  it('子代理摘要不含父 EventBus 上的 text_delta（EventBus 隔离）', async () => {
    const reg = baseRegistry()
    const parentBus = new EventBus()
    const client = new MockModelClient()
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'text_delta', delta: 'sub-only-text' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })
    const tool = createTaskTool({
      modelClient: client,
      parentEventBus: parentBus,
      resolveTool: (n) => reg.getTool(n)
    })
    const run = tool.execute({ subagent_type: 'explore', task: 'x' }, ctx)
    parentBus.emit({ type: 'text_delta', messageId: 'parent-msg', delta: 'PARENT_LEAK' })
    const result = await run
    expect(result.output).toContain('sub-only-text')
    expect(result.output).not.toContain('PARENT_LEAK')
  })

  it('explore 子代理 ToolRegistry 白名单不含 write（即使父注册表有）', async () => {
    const reg = baseRegistry()
    reg.register({
      name: 'write',
      description: 'write',
      parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } } },
      async execute(): Promise<ToolResult> {
        return { success: true, output: 'written' }
      }
    })
    const client = new MockModelClient()
    client.addResponse({
      events: [
        { type: 'message_start' },
        {
          type: 'tool_call',
          toolCall: { id: 'w1', name: 'write', arguments: JSON.stringify({ path: 'a.ts', content: 'x' }) }
        },
        { type: 'message_end', finishReason: 'tool_calls' }
      ]
    })
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'text_delta', delta: 'blocked' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })
    const tool = createTaskTool({
      modelClient: client,
      parentEventBus: new EventBus(),
      resolveTool: (n) => reg.getTool(n)
    })
    const result = await tool.execute({ subagent_type: 'explore', task: 'write a.ts' }, ctx)
    const secondCall = client.getCalls()[1]
    expect(secondCall).toBeDefined()
    const blocked = secondCall.messages
      .filter(m => m.role === 'tool')
      .some(m => String(m.content).includes('未注册') || String(m.content).includes('不可用'))
    expect(blocked).toBe(true)
    expect(result.output).toContain('blocked')
  })

  it('permission_request 转发到父 EventBus', async () => {
    const reg = baseRegistry()
    reg.register({
      name: 'bash',
      description: 'bash',
      parameters: { type: 'object', properties: { command: { type: 'string' } } },
      executionMode: 'sequential',
      async execute(): Promise<ToolResult> {
        return { success: true, output: 'ok' }
      }
    })
    const client = new MockModelClient()
    client.addResponse({
      events: [
        { type: 'message_start' },
        {
          type: 'tool_call',
          toolCall: { id: 'b1', name: 'bash', arguments: JSON.stringify({ command: 'echo hi' }) }
        },
        { type: 'message_end', finishReason: 'tool_calls' }
      ]
    })
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'text_delta', delta: 'done' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })
    const parentBus = new EventBus()
    const forwarded: string[] = []
    const permissionBridge = new SubAgentPermissionBridge()
    parentBus.on((e) => {
      if (e.type === 'permission_request') {
        forwarded.push(e.requestId)
        expect(e.requestId.startsWith(SUB_PERMISSION_PREFIX)).toBe(true)
        permissionBridge.resolve(e.requestId, true)
      }
    })
    const tool = createTaskTool({
      modelClient: client,
      parentEventBus: parentBus,
      permissionBridge,
      resolveTool: (n) => reg.getTool(n)
    })
    await tool.execute({ subagent_type: 'code', task: 'run echo' }, ctx)
    expect(forwarded.length).toBe(1)
  })

  it('工具名称为 task', () => {
    const tool = createTaskTool({
      modelClient: new MockModelClient(),
      parentEventBus: new EventBus(),
      resolveTool: () => undefined
    })
    expect(tool.name).toBe('task')
  })

  it('executionMode 为 sequential', () => {
    const tool = createTaskTool({
      modelClient: new MockModelClient(),
      parentEventBus: new EventBus(),
      resolveTool: () => undefined
    })
    expect(tool.executionMode).toBe('sequential')
  })

  it('子代理无输出时返回占位文本', async () => {
    const reg = baseRegistry()
    const client = new MockModelClient()
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })
    const tool = createTaskTool({
      modelClient: client,
      parentEventBus: new EventBus(),
      resolveTool: (n) => reg.getTool(n)
    })
    const result = await tool.execute({ subagent_type: 'explore', task: 'x' }, ctx)
    expect(result.output).toContain('子代理')
  })

  it('输出含子代理类型标记', async () => {
    const reg = baseRegistry()
    const client = new MockModelClient()
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'text_delta', delta: 'ok' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })
    const tool = createTaskTool({
      modelClient: client,
      parentEventBus: new EventBus(),
      resolveTool: (n) => reg.getTool(n)
    })
    const result = await tool.execute({ subagent_type: 'explore', task: 'x' }, ctx)
    expect(result.output).toContain('explore')
  })

  it('required 参数 schema 含 subagent_type', () => {
    const tool = createTaskTool({
      modelClient: new MockModelClient(),
      parentEventBus: new EventBus(),
      resolveTool: () => undefined
    })
    expect(tool.parameters.required).toContain('subagent_type')
  })

  it('code 子代理可实例化', async () => {
    const reg = baseRegistry()
    const client = new MockModelClient()
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'text_delta', delta: 'done' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })
    const tool = createTaskTool({
      modelClient: client,
      parentEventBus: new EventBus(),
      resolveTool: (n) => reg.getTool(n)
    })
    const result = await tool.execute({ subagent_type: 'code', task: 'add fn' }, ctx)
    expect(result.success).toBe(true)
  })
})
