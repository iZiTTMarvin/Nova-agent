import { describe, expect, it } from 'vitest'
import { AgentLoop } from '../../../../src/runtime/agent/AgentLoop'
import { EventBus } from '../../../../src/runtime/agent/EventBus'
import { buildConversationContext } from '../../../../src/runtime/sessions'
import { MockModelClient } from '../../../../src/test-support/builders/MockModelClient'
import { PermissionManager } from '../../../../src/runtime/permissions/PermissionManager'
import { ToolRegistry } from '../../../../src/runtime/tools/ToolRegistry'
import type { ToolContext, ToolResult } from '../../../../src/runtime/tools/types'
import { agentRoute } from '../../../../src/runtime/agent/turn'
import type { AgentEvent } from '../../../../src/runtime/agent/types'
import type { SessionData } from '../../../../src/runtime/sessions/types'
import type { MessageBlock } from '../../../../src/shared/session/types'

function createLoop(client: MockModelClient) {
  const registry = new ToolRegistry()
  registry.register({
    name: 'ls',
    description: '列出目录',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } }
    },
    async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
      return { success: true, output: `目录内容: ${args.path ?? '.'}` }
    }
  })
  const eventBus = new EventBus()
  const loop = new AgentLoop(client, eventBus, {
    permissionManager: new PermissionManager(),
    permissionMode: 'full_access'
  })
  loop.setToolRegistry(registry)
  return { loop, eventBus }
}

describe('在飞 origin 与档案投影编号对齐', () => {
  it('同一条 assistant 落盘后，blocks 工具组序号 === 各子轮 origin.step === 在飞 toolRound', async () => {
    const client = new MockModelClient()
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'text_delta', delta: '先看目录' },
        { type: 'tool_call', toolCall: { id: 'call_1', name: 'ls', arguments: '{"path":"."}' } },
        { type: 'message_end', finishReason: 'tool_calls' }
      ]
    })
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'text_delta', delta: '再看 src' },
        { type: 'tool_call', toolCall: { id: 'call_2', name: 'ls', arguments: '{"path":"src"}' } },
        { type: 'message_end', finishReason: 'tool_calls' }
      ]
    })
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'text_delta', delta: '看完了' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })

    const { loop, eventBus } = createLoop(client)
    const events: AgentEvent[] = []
    eventBus.on(event => events.push(event))

    const userMessageId = 'msg_user_origin'
    await loop.sendMessage('列出目录', agentRoute(), { userMessageId })

    const start = events.find(event => event.type === 'message_start')
    const end = events.find(event => event.type === 'message_end')
    expect(start?.type).toBe('message_start')
    expect(end?.type).toBe('message_end')
    if (start?.type !== 'message_start' || end?.type !== 'message_end') return
    expect(start.messageId).toBe(end.messageId)

    const runtime = loop.getContext().filter(m => m.role !== 'system')
    const inFlightSteps = runtime
      .filter(m => m.role === 'assistant' || m.role === 'tool')
      .map(m => m.origin?.step)
    expect(inFlightSteps).toEqual([0, 0, 1, 1, 2])
    expect(runtime.find(m => m.role === 'user')?.origin).toEqual({
      messageId: userMessageId,
      step: 0
    })
    expect(
      runtime
        .filter(m => m.role === 'assistant' || m.role === 'tool')
        .every(m => m.origin?.messageId === start.messageId)
    ).toBe(true)

    const blocks: MessageBlock[] = [
      { type: 'text', content: '先看目录' },
      {
        type: 'tool',
        toolCallId: 'call_1',
        toolName: 'ls',
        arguments: { path: '.' },
        status: 'success',
        result: '目录内容: .'
      },
      { type: 'text', content: '再看 src' },
      {
        type: 'tool',
        toolCallId: 'call_2',
        toolName: 'ls',
        arguments: { path: 'src' },
        status: 'success',
        result: '目录内容: src'
      },
      { type: 'text', content: '看完了' }
    ]
    const session: SessionData = {
      schemaVersion: 8,
      id: 'sess_origin',
      workspaceRoot: '/tmp/project',
      mode: 'default',
      messages: [
        { id: userMessageId, role: 'user', content: '列出目录', timestamp: 1 },
        {
          id: start.messageId,
          role: 'assistant',
          content: '看完了',
          blocks,
          timestamp: 2
        }
      ],
      createdAt: 1,
      updatedAt: 2
    } as SessionData

    const archived = buildConversationContext(session, 'default')
    expect(
      archived.filter(m => m.role === 'assistant' || m.role === 'tool').map(m => m.origin?.step)
    ).toEqual(inFlightSteps)
    expect(archived.filter(m => m.role === 'assistant').map(m => m.origin?.step)).toEqual([0, 1, 2])
  })
})
