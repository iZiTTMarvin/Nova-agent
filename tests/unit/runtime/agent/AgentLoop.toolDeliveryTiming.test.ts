/**
 * tool_delivery 事件时序：提交时不发事件、原文投递；首次投影归档时发一次 archive 事件。
 * 保护契约：最新一步工具结果全文进下一次请求（不归档、不发事件），
 * 归档只发生一次且事件只发一次，权威上下文永远保留全文。
 */
import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { AgentLoop } from '../../../../src/runtime/agent/AgentLoop'
import { EventBus } from '../../../../src/runtime/agent/EventBus'
import { MockModelClient } from '../../../../src/test-support/builders/MockModelClient'
import { agentRoute } from '../../../../src/runtime/agent/turn'
import { PermissionManager } from '../../../../src/runtime/permissions/PermissionManager'
import { ToolRegistry } from '../../../../src/runtime/tools/ToolRegistry'
import type { ToolContext, ToolResult } from '../../../../src/runtime/tools/types'
import { ArtifactStore } from '../../../../src/runtime/artifacts/ArtifactStore'
import { isArchivedPlaceholder } from '../../../../src/runtime/request-projection'
import type { AgentEvent } from '../../../../src/runtime/agent/types'

describe('AgentLoop tool_delivery 时序', () => {
  it('提交时原文投递不发事件，首次归档投影发且只发一次 archive 事件', async () => {
    const huge = 'x'.repeat(18 * 1024)
    const tmp = mkdtempSync(join(tmpdir(), 'nova-delivery-timing-'))
    const client = new MockModelClient()
    const toolTurn = (id: string, path: string) => ({
      events: [
        { type: 'message_start' as const },
        {
          type: 'tool_call' as const,
          toolCall: { id, name: 'ls', arguments: JSON.stringify({ path }) }
        },
        { type: 'message_end' as const, finishReason: 'tool_calls' as const }
      ]
    })
    const textTurn = (text: string) => ({
      events: [
        { type: 'message_start' as const },
        { type: 'text_delta' as const, delta: text },
        { type: 'message_end' as const, finishReason: 'stop' as const }
      ]
    })
    client.addResponse(toolTurn('call_huge', '.'))
    client.addResponse(textTurn('目录已列出'))
    client.addResponse(toolTurn('call_follow', 'src'))
    client.addResponse(textTurn('继续'))

    const registry = new ToolRegistry()
    registry.register({
      name: 'ls',
      description: '列出目录',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } }
      },
      async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
        return { success: true, output: args.path === '.' ? huge : 'src/' }
      }
    })
    registry.register({
      name: 'archive_read',
      description: '回读归档',
      parameters: { type: 'object', properties: {} },
      async execute(): Promise<ToolResult> {
        return { success: true, output: '' }
      }
    })

    const events: AgentEvent[] = []
    const eventBus = new EventBus()
    const unsubscribe = eventBus.on(event => {
      if (event.type === 'tool_delivery') events.push(event)
    })
    const loop = new AgentLoop(client, eventBus, {
      permissionManager: new PermissionManager(),
      permissionMode: 'full_access'
    })
    loop.setToolRegistry(registry)
    loop.setSessionId('sess_delivery_timing')
    loop.setArtifactStore(new ArtifactStore(tmp))

    try {
      await loop.sendMessage('列出根目录', agentRoute())

      // 第 1 轮：全文投递给紧随其后的请求，未归档、未发 tool_delivery
      expect(events).toHaveLength(0)
      const firstView = client.getCalls()[1].messages
      const hugeInView = firstView.find(m => m.role === 'tool' && m.toolCallId === 'call_huge')
      expect(hugeInView?.content).toBe(huge)

      await loop.sendMessage('再看 src', agentRoute())

      // 第 2 轮首次投影归档：事件恰好一次，kind 为 archive
      const deliveries = events.filter(e => e.toolCallId === 'call_huge')
      expect(deliveries).toHaveLength(1)
      expect(deliveries[0]!.delivery.kind).toBe('archive')

      const calls = client.getCalls()
      const toolContent = (callIndex: number): string => {
        const msg = calls[callIndex].messages.find(
          m => m.role === 'tool' && m.toolCallId === 'call_huge'
        )
        return typeof msg?.content === 'string' ? msg.content : ''
      }
      expect(isArchivedPlaceholder(toolContent(2))).toBe(true)
      expect(toolContent(3)).toBe(toolContent(2))
    } finally {
      unsubscribe()
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
