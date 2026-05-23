import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AgentLoop } from '../../../../src/runtime/agent/AgentLoop'
import { EventBus } from '../../../../src/runtime/agent/EventBus'
import type { ModelClient, ChatEvent, ToolDefinition } from '../../../../src/runtime/model/types'

/** 创建 mock ModelClient，返回空流 */
function createMockClient(): ModelClient {
  return {
    async *chat(): AsyncIterable<ChatEvent> {
      yield { type: 'message_start' }
      yield { type: 'message_end', finishReason: 'stop' }
    },
    updateConfig() {}
  } as unknown as ModelClient
}

/** 捕获 AgentLoop 发给模型的 tools 参数 */
function captureTools(): { client: ModelClient; getTools: () => ToolDefinition[] | undefined } {
  let capturedTools: ToolDefinition[] | undefined

  const client: ModelClient = {
    async *chat(_msgs: unknown, tools?: ToolDefinition[]): AsyncIterable<ChatEvent> {
      capturedTools = tools
      yield { type: 'message_start' }
      yield { type: 'message_end', finishReason: 'stop' }
    },
    updateConfig() {}
  } as unknown as ModelClient

  return { client, getTools: () => capturedTools }
}

const READONLY_TOOLS = ['ls', 'read', 'grep', 'find']
const WRITE_TOOLS = ['edit', 'write', 'bash']
const ALL_TOOLS = [...READONLY_TOOLS, ...WRITE_TOOLS]

function makeToolDefs(names: string[]): ToolDefinition[] {
  return names.map(name => ({
    name,
    description: `${name} tool`,
    parameters: { type: 'object', properties: {} }
  }))
}

describe('AgentLoop 工具过滤 (T13-B)', () => {
  it('plan 模式只暴露只读工具', async () => {
    const { client, getTools } = captureTools()
    const eventBus = new EventBus()
    const loop = new AgentLoop(client, eventBus)
    loop.setMode('plan')

    // 模拟 ToolRegistry.getToolDefinitions 返回全部 7 个工具
    const allDefs = makeToolDefs(ALL_TOOLS)
    const mockRegistry = {
      getToolDefinitions: () => allDefs,
      execute: vi.fn()
    }
    loop.setToolRegistry(mockRegistry as any)

    await loop.sendMessage('test')

    const tools = getTools()
    const toolNames = tools?.map(t => t.name) ?? []
    for (const name of READONLY_TOOLS) {
      expect(toolNames).toContain(name)
    }
    for (const name of WRITE_TOOLS) {
      expect(toolNames).not.toContain(name)
    }
  })

  it('default 模式暴露全部工具', async () => {
    const { client, getTools } = captureTools()
    const eventBus = new EventBus()
    const loop = new AgentLoop(client, eventBus)
    loop.setMode('default')

    const allDefs = makeToolDefs(ALL_TOOLS)
    const mockRegistry = {
      getToolDefinitions: () => allDefs,
      execute: vi.fn()
    }
    loop.setToolRegistry(mockRegistry as any)

    await loop.sendMessage('test')

    const tools = getTools()
    const toolNames = tools?.map(t => t.name) ?? []
    expect(toolNames).toEqual(ALL_TOOLS)
  })

  it('auto 模式暴露全部工具', async () => {
    const { client, getTools } = captureTools()
    const eventBus = new EventBus()
    const loop = new AgentLoop(client, eventBus)
    loop.setMode('auto')

    const allDefs = makeToolDefs(ALL_TOOLS)
    const mockRegistry = {
      getToolDefinitions: () => allDefs,
      execute: vi.fn()
    }
    loop.setToolRegistry(mockRegistry as any)

    await loop.sendMessage('test')

    const tools = getTools()
    const toolNames = tools?.map(t => t.name) ?? []
    expect(toolNames).toEqual(ALL_TOOLS)
  })

  it('plan 模式下被禁止的工具调用不发射 tool_call 事件', async () => {
    const events: any[] = []
    const eventBus = new EventBus()
    eventBus.on(e => events.push(e))
    const seenToolResultsByModel: string[] = []

    // 模型返回一个 write 工具调用
    const client: ModelClient = {
      async *chat(messages: unknown): AsyncIterable<ChatEvent> {
        const chatMessages = messages as Array<{ role: string; content: string; toolCallId?: string }>
        const lastToolMessage = [...chatMessages].reverse().find(msg => msg.role === 'tool')

        if (!lastToolMessage) {
          yield { type: 'message_start' }
          yield { type: 'text_delta', delta: 'thinking...' }
          yield {
            type: 'tool_call',
            toolCall: { id: 'tc_1', name: 'write', arguments: '{}' }
          }
          yield { type: 'message_end', finishReason: 'tool_calls' }
          return
        }

        seenToolResultsByModel.push(lastToolMessage.content)
        yield { type: 'message_start' }
        yield { type: 'text_delta', delta: '继续规划' }
        yield { type: 'message_end', finishReason: 'stop' }
      },
      updateConfig() {}
    } as unknown as ModelClient

    const loop = new AgentLoop(client, eventBus)
    loop.setMode('plan')

    const allDefs = makeToolDefs(ALL_TOOLS)
    const mockRegistry = {
      getToolDefinitions: () => allDefs,
      execute: vi.fn()
    }
    loop.setToolRegistry(mockRegistry as any)

    await loop.sendMessage('test')

    const toolCallEvents = events.filter(e => e.type === 'tool_call')
    const toolResultEvents = events.filter(e => e.type === 'tool_result')
    expect(toolCallEvents).toHaveLength(0)
    expect(toolResultEvents).toHaveLength(0)
    expect(seenToolResultsByModel).toEqual([
      expect.stringContaining('当前为 plan 模式')
    ])
  })
})
