/**
 * artifact 端到端链路集成测试
 *
 * 验证：工具执行 → tool_result 事件 → SessionToolCall 持久化 → contextBuilder 恢复
 */
import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ToolRegistry } from '../../../../src/runtime/tools/ToolRegistry'
import { executeToolBatch } from '../../../../src/runtime/agent/toolBatchExecutor'
import { buildConversationContext } from '../../../../src/runtime/agent/context/contextBuilder'
import { ArtifactStore } from '../../../../src/runtime/artifacts/ArtifactStore'
import { createReadState } from '../../../../src/runtime/tools/editTool'
import type { AgentEvent } from '../../../../src/runtime/agent/types'
import type { SessionData, SessionMessage } from '../../../../src/runtime/sessions/types'
import type { ToolContext, ToolResult } from '../../../../src/runtime/tools/types'

describe('artifact 持久化链路', () => {
  it('executeToolBatch → SessionMessage → buildConversationContext 保留 artifactId', async () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'nova-artifact-e2e-'))
    const sessionId = 'sess_e2e'
    const store = new ArtifactStore(sessionsDir)
    const artifactId = 'deadbeefcafe'
    const truncationMeta = {
      totalBytes: 200_000,
      totalLines: 1000,
      shownLines: 50,
      truncated: true
    }

    const registry = new ToolRegistry()
    registry.register({
      name: 'bash',
      description: 'mock bash',
      executionMode: 'sequential',
      parameters: { type: 'object', properties: {} },
      async execute(): Promise<ToolResult> {
        return {
          success: true,
          output: `tail...\n[输出已截断]\n完整输出: artifact://${artifactId}`,
          artifactId,
          truncationMeta
        }
      }
    })

    const events: AgentEvent[] = []
    const result = await executeToolBatch({
      toolCalls: [{ id: 'tc_e2e', name: 'bash', arguments: '{}' }],
      messageId: 'msg_e2e',
      toolRegistry: registry,
      workingDir: process.cwd(),
      mode: 'default',
      supportsVision: false,
      checkpointManager: null,
      abortSignal: undefined,
      checkPermission: async () => ({ allowed: true, reason: '' }),
      emit: (e) => events.push(e),
      applyTruncation: (o) => o,
      maxParallelToolCalls: 1,
      toolExecution: 'sequential',
      sessionId,
      artifactStore: store,
      readState: createReadState()
    })

    expect(result.outcomes[0].artifactId).toBe(artifactId)
    expect(result.outcomes[0].truncationMeta).toEqual(truncationMeta)

    const toolResultEvent = events.find(e => e.type === 'tool_result')
    expect(toolResultEvent).toBeDefined()
    if (toolResultEvent?.type === 'tool_result') {
      expect(toolResultEvent.artifactId).toBe(artifactId)
      expect(toolResultEvent.truncationMeta).toEqual(truncationMeta)
    }

    // 模拟 saveAssistantMessage 持久化结构
    const sessionMessage: SessionMessage = {
      id: 'msg_e2e',
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      toolCalls: [{
        id: 'tc_e2e',
        name: 'bash',
        arguments: '{}',
        result: result.outcomes[0].resultText,
        artifactId,
        truncationMeta
      }]
    }

    const session: SessionData = {
      schemaVersion: 2,
      id: sessionId,
      workspaceRoot: process.cwd(),
      mode: 'default',
      messages: [sessionMessage],
      createdAt: 1,
      updatedAt: 2
    }

    const context = buildConversationContext(session, 'default')
    const toolMsg = context.find(m => m.role === 'tool')
    expect(toolMsg?.artifactId).toBe(artifactId)
    expect(toolMsg?.truncationMeta).toEqual(truncationMeta)

    rmSync(sessionsDir, { recursive: true, force: true })
  })

  it('buildToolContext 透传 artifactStore 到工具执行层', async () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'nova-artifact-ctx-'))
    const sessionId = 'sess_ctx'
    const store = new ArtifactStore(sessionsDir)
    let seenStore: ToolContext['artifactStore']

    const registry = new ToolRegistry()
    registry.register({
      name: 'probe',
      description: 'probe',
      executionMode: 'sequential',
      parameters: { type: 'object', properties: {} },
      async execute(_args, ctx): Promise<ToolResult> {
        seenStore = ctx.artifactStore
        return { success: true, output: 'ok' }
      }
    })

    await executeToolBatch({
      toolCalls: [{ id: 'tc_1', name: 'probe', arguments: '{}' }],
      messageId: 'msg_1',
      toolRegistry: registry,
      workingDir: process.cwd(),
      mode: 'default',
      supportsVision: false,
      checkpointManager: null,
      abortSignal: undefined,
      checkPermission: async () => ({ allowed: true, reason: '' }),
      emit: () => {},
      applyTruncation: (o) => o,
      maxParallelToolCalls: 1,
      toolExecution: 'sequential',
      sessionId,
      artifactStore: store,
      readState: createReadState()
    })

    expect(seenStore).toBe(store)
    rmSync(sessionsDir, { recursive: true, force: true })
  })
})
