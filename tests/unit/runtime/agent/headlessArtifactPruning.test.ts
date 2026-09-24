import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { describe, expect, it } from 'vitest'
import { AgentLoop } from '../../../../src/runtime/agent/AgentLoop'
import { EventBus } from '../../../../src/runtime/agent/EventBus'
import { agentRoute } from '../../../../src/runtime/agent/turn'
import { ArtifactStore } from '../../../../src/runtime/artifacts/ArtifactStore'
import { archiveReadTool } from '../../../../src/runtime/tools/archiveRead'
import { ToolRegistry } from '../../../../src/runtime/tools/ToolRegistry'
import { createReadState } from '../../../../src/runtime/tools/editTool'
import type { ToolContext, ToolResult } from '../../../../src/runtime/tools/types'
import { MockModelClient } from '../../../../src/test-support/builders/MockModelClient'
import { PermissionManager } from '../../../../src/runtime/permissions/PermissionManager'

describe('headless artifact pruning', () => {
  it('最新结果先全文投递，下一步归档后同命名空间可通过 archive_read 校验回读', async () => {
    const logsDir = mkdtempSync(join(tmpdir(), 'nova-headless-artifacts-'))
    const sessionId = 'headless-run'
    const body = Array.from({ length: 5000 }, (_, index) => `line-${index + 1}`).join('\n')
    const client = new MockModelClient()
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'tool_call_start', toolCallId: 'tc-large', toolName: 'large_output', index: 0 },
        {
          type: 'tool_call',
          toolCall: { id: 'tc-large', name: 'large_output', arguments: '{}' }
        },
        { type: 'message_end', finishReason: 'tool_calls' }
      ]
    })
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'tool_call_start', toolCallId: 'tc-ping', toolName: 'ping', index: 0 },
        {
          type: 'tool_call',
          toolCall: { id: 'tc-ping', name: 'ping', arguments: '{}' }
        },
        { type: 'message_end', finishReason: 'tool_calls' }
      ]
    })
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'text_delta', delta: '已读取归档' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })

    const registry = new ToolRegistry()
    registry.register({
      name: 'large_output',
      description: 'returns a large result',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      executionMode: 'sequential',
      async execute(_args: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
        return { success: true, output: body }
      }
    })
    registry.register({
      name: 'ping',
      description: 'returns a small result',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      executionMode: 'sequential',
      async execute(_args: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
        return { success: true, output: 'y'.repeat(36_000) }
      }
    })
    registry.register(archiveReadTool)

    const store = new ArtifactStore(logsDir)
    const loop = new AgentLoop(client, new EventBus(), {
      permissionManager: new PermissionManager(),
      maxToolRounds: 4,
      toolExecution: 'sequential',
      maxParallelToolCalls: 1,
      supportsVision: false,
      permissionMode: 'full_access',
      toolDialectOverride: 'native',
      contextWindow: 40_000
    })
    loop.setToolRegistry(registry)
    loop.setArtifactStore(store)
    loop.setSessionId(sessionId)
    loop.setWorkingDir(logsDir)
    loop.setWorkspaceRoot(logsDir)
    loop.setRunRef(sessionId)

    try {
      await expect(loop.sendMessage('生成并读取大输出', agentRoute())).resolves.toEqual({
        status: 'completed'
      })

      const calls = client.getCalls()
      const toolContent = (callIndex: number, toolCallId: string): string => {
        const toolMessage = calls[callIndex].messages.find(
          message => message.role === 'tool' && message.toolCallId === toolCallId
        )
        expect(toolMessage).toBeDefined()
        expect(typeof toolMessage?.content).toBe('string')
        return toolMessage?.content as string
      }

      // 第 1 次看到该结果：全文投递（延后一步归档）
      expect(toolContent(1, 'tc-large')).toBe(body)

      // 第 2 次看到该结果：其后已有 ~9K token 投递，滑出最近窗口（8K），已是占位符
      const placeholderView = toolContent(2, 'tc-large')
      const placeholder = JSON.parse(placeholderView) as {
        kind: string
        artifactId: string
        resourceRef: string
      }
      expect(placeholder.kind).toBe('nova.archived_tool_result')

      const artifactPath = store.resolvePath(sessionId, placeholder.artifactId)
      expect(existsSync(artifactPath)).toBe(true)
      expect(readFileSync(artifactPath, 'utf8')).toBe(body)

      const reread = await archiveReadTool.execute(
        { ref: placeholder.resourceRef, operation: 'read', offset: 4321, limit: 1 },
        {
          workingDir: logsDir,
          readState: createReadState(),
          artifactStore: store,
          sessionId
        }
      )
      expect(reread.success).toBe(true)
      expect(JSON.parse(reread.output)).toMatchObject({
        lines: ['line-4321'],
        offset: 4321,
        totalLines: 5000
      })
    } finally {
      loop.dispose()
      rmSync(logsDir, { recursive: true, force: true })
    }
  })
})
