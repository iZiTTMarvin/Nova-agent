import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { prepareSubagentRuntime } from '../../../src/main/agent/runtime/SubagentRuntimeFactory'
import { extractTextFromContent } from '../../../src/runtime/model/types'
import { agentRoute } from '../../../src/runtime/agent/turn'
import { createEmptyCodeContextPack } from '../../../src/runtime/code-graph/context'
import { createCodeContextTool } from '../../../src/runtime/tools/codeContext'
import { SessionStore } from '../../../src/runtime/sessions'
import { DEFAULT_NOVA_SETTINGS } from '../../../src/runtime/settings/novaSettings'
import { resolveSubagentProfileSnapshot } from '../../../src/runtime/subagents'
import { createReadState } from '../../../src/runtime/tools/editTool'
import { MockModelClient } from '../../../src/test-support/builders/MockModelClient'

vi.mock('../../../src/main/agent/runtime/AgentRuntimeFactory', () => ({
  buildModelPoolWithFallbacks: (client: unknown) => client
}))

describe('SubagentRuntimeFactory', () => {
  const roots: string[] = []

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  it('重建 interrupted Child AgentLoop 时回灌历史，并忽略未注册的 profile 工具', async () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'nova-subagent-runtime-'))
    roots.push(sessionsDir)
    const workspace = resolve(sessionsDir, 'workspace')
    const store = new SessionStore(sessionsDir)
    const parent = store.create(workspace)
    const skillRoot = resolve(workspace, 'skills', 'inspect')
    const child = store.createChildIfAbsent({
      workspaceRoot: workspace,
      mode: 'plan',
      task: 'inspect',
      subagent: {
        lineage: {
          parentSessionId: parent.id,
          parentRunId: 'run-parent',
          rootRunId: 'run-parent',
          depth: 1,
          spawnKey: 'spawn-key',
          spawnRunId: 'run-child',
          origin: {
            kind: 'skill_fork',
            parentMessageId: 'message-parent',
            skillName: 'inspect'
          }
        },
        profile: resolveSubagentProfileSnapshot({
          name: 'skill:inspect',
          description: 'read only',
          prompt: 'inspect',
          allowedTools: ['code_context'],
          skillRoots: [skillRoot]
        }, 'skill:inspect')
      }
    }).session
    store.appendMessage(child.id, {
      id: 'child-user',
      role: 'user',
      content: '此前的问题',
      timestamp: 1
    })
    store.appendMessage(child.id, {
      id: 'child-assistant',
      role: 'assistant',
      content: '此前的分析结果',
      timestamp: 2
    })
    const reloaded = store.load(child.id)
    if (!reloaded || reloaded.kind !== 'subagent') throw new Error('expected child')

    const prepared = prepareSubagentRuntime({
      profile: reloaded.subagent.profile,
      task: 'inspect',
      workingDirectory: workspace,
      isolation: 'readonly',
      childSession: reloaded,
      parentRunId: 'run-parent',
      rootRunId: 'run-parent',
      modelClient: new MockModelClient(),
      resolveTool: () => undefined,
      sessionStore: store,
      sessionsDir,
      novaSettings: DEFAULT_NOVA_SETTINGS,
      readState: createReadState(),
      contextWindow: 32_000,
      supportsVision: false
    })

    const history = prepared.agentLoop.getContext().map((message) =>
      extractTextFromContent(message.content)
    )
    expect(history).toContain('此前的问题')
    expect(history).toContain('此前的分析结果')
    expect(prepared.agentLoop.getSkillRoots()).toEqual([skillRoot])
    expect(prepared.agentLoop.getFrozenSystemPrompt()).not.toContain('code_context')
    prepared.agentLoop.dispose()

    const client = new MockModelClient()
      .addResponse({
        events: [
          { type: 'message_start' },
          {
            type: 'tool_call',
            toolCall: {
              id: 'tc_code_context',
              name: 'code_context',
              arguments: JSON.stringify({ query: 'verifyToken', intent: 'locate' })
            }
          },
          { type: 'message_end', finishReason: 'tool_calls' }
        ]
      })
      .addResponse({
        events: [
          { type: 'message_start' },
          { type: 'text_delta', delta: '已完成查询' },
          { type: 'message_end', finishReason: 'stop' }
        ]
      })
    const codeContextTool = createCodeContextTool({
      getQueryPort: () => ({
        query: async () => createEmptyCodeContextPack({
          status: 'ready',
          revision: 2,
          intent: 'locate',
          summary: 'ready · locate · verifyToken',
          warnings: []
        })
      })
    })
    const enabled = prepareSubagentRuntime({
      profile: reloaded.subagent.profile,
      task: 'inspect',
      workingDirectory: workspace,
      isolation: 'readonly',
      childSession: reloaded,
      parentRunId: 'run-parent',
      rootRunId: 'run-parent',
      modelClient: client,
      resolveTool: (name) => name === 'code_context' ? codeContextTool : undefined,
      sessionStore: store,
      sessionsDir,
      novaSettings: DEFAULT_NOVA_SETTINGS,
      readState: createReadState(),
      contextWindow: 32_000,
      supportsVision: false
    })
    enabled.agentLoop.setRunRef('run-child')

    await enabled.agentLoop.sendMessage('inspect', agentRoute())

    expect(client.getCalls()[0]?.tools?.map((tool) => tool.name)).toContain('code_context')
    const secondCallText = client.getCalls()[1]?.messages
      .map((message) => extractTextFromContent(message.content))
      .join('\n') ?? ''
    expect(secondCallText).toContain('"status":"ready"')
    enabled.agentLoop.dispose()
  })
})
