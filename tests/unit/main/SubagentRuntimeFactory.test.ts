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
import type { ToolExecutor } from '../../../src/runtime/tools/types'
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
      mode: 'default',
      permissionMode: 'request_approval',
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

    // 子代理与主代理共用同一份 Task Policy：装配且无重复
    const systemText = extractTextFromContent(
      prepared.agentLoop.getContext().find((m) => m.role === 'system')!.content
    )
    expect(systemText.match(/=== Task Policy ===/g)).toHaveLength(1)

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

describe('SubagentRuntimeFactory 权限装配', () => {
  const roots: string[] = []

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  async function prepareReadonlyChild(input: {
    isolation: 'shared' | 'readonly'
    profileId?: 'explore' | 'code'
    toolAuthorizationPolicy?: import('../../../src/runtime/permissions/PermissionCoordinator').ToolAuthorizationPolicy
  }) {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'nova-subagent-perm-'))
    roots.push(sessionsDir)
    const workspace = resolve(sessionsDir, 'workspace')
    const store = new SessionStore(sessionsDir)
    const parent = store.create(workspace, 'default', { permissionMode: 'full_access' })
    const profileId = input.profileId ?? 'explore'
    const profile = resolveSubagentProfileSnapshot({
      name: profileId,
      description: profileId === 'explore' ? 'read only' : 'workspace writer',
      prompt: 'inspect',
      allowedTools: profileId === 'explore' ? ['read', 'grep'] : ['read', 'write', 'bash']
    }, profileId)
    const resolveTool = (name: string): ToolExecutor | undefined =>
      profile.toolNames.includes(name)
        ? {
            name,
            description: `${name} tool`,
            parameters: { type: 'object', properties: {} },
            execute: async () => ({ success: true, output: '' })
          }
        : undefined
    const child = store.createChildIfAbsent({
      workspaceRoot: workspace,
      mode: 'default',
      permissionMode: 'full_access',
      task: 'inspect',
      subagent: {
        lineage: {
          parentSessionId: parent.id,
          parentRunId: 'run-parent',
          rootRunId: 'run-parent',
          depth: 1,
          spawnKey: 'spawn-perm',
          spawnRunId: 'run-child-perm',
          origin: {
            kind: 'task_tool',
            parentMessageId: 'message-parent',
            parentToolCallId: 'call-task'
          }
        },
        profile
      }
    }).session
    const prepared = prepareSubagentRuntime({
      profile,
      task: 'inspect',
      workingDirectory: workspace,
      isolation: input.isolation,
      childSession: child,
      parentRunId: 'run-parent',
      rootRunId: 'run-parent',
      modelClient: new MockModelClient(),
      resolveTool,
      sessionStore: store,
      sessionsDir,
      readState: createReadState(),
      contextWindow: 32_000,
      supportsVision: false,
      ...(input.toolAuthorizationPolicy ? { toolAuthorizationPolicy: input.toolAuthorizationPolicy } : {})
    })
    return { prepared, dispose: () => prepared.agentLoop.dispose() }
  }

  it('只读上限独立于 Default 模式拒绝 Shell 与进程控制', async () => {
    const { prepared, dispose } = await prepareReadonlyChild({ isolation: 'shared' })
    const permissionRequests: string[] = []
    const unsubscribe = prepared.agentLoop.getEventBus().on((event) => {
      if (event.type !== 'permission_request') return
      permissionRequests.push(event.requestId)
      prepared.agentLoop.respondPermission(event.requestId, false)
    })
    const results = await prepared.agentLoop.checkBatchPermission([
      { toolCallId: 'tc_bash', toolName: 'bash', args: { command: 'npm test' } },
      { toolCallId: 'tc_interrupt', toolName: 'shell_session', args: { action: 'interrupt', ref: 'p' } },
      { toolCallId: 'tc_read', toolName: 'read', args: { path: 'a.ts' } }
    ], 'msg-child')
    const modeResult = await prepared.agentLoop.checkBatchPermission([
      { toolCallId: 'tc_mode', toolName: 'switch_mode', args: { mode: 'default' } }
    ], 'msg-child')
    expect(results.get('tc_bash')).toMatchObject({ allowed: false })
    expect(results.get('tc_interrupt')).toMatchObject({ allowed: false })
    expect(results.get('tc_read')).toMatchObject({ allowed: true })
    expect(modeResult.get('tc_mode')).toMatchObject({ allowed: true })
    expect(permissionRequests).toEqual([])
    unsubscribe()
    dispose()
  })

  it('调用隔离收窄实现型 profile 时，模型目录不再暴露写入与 Shell', async () => {
    const { prepared, dispose } = await prepareReadonlyChild({
      isolation: 'readonly',
      profileId: 'code'
    })
    const systemPrompt = prepared.agentLoop.getFrozenSystemPrompt()
    expect(systemPrompt).toContain('- read: read tool')
    expect(systemPrompt).not.toContain('- write: write tool')
    expect(systemPrompt).not.toContain('- bash: bash tool')
    dispose()
  })

  it('compose 阶段门禁 overlay 随子代理继承，只能收窄', async () => {
    const { prepared, dispose } = await prepareReadonlyChild({
      isolation: 'shared',
      toolAuthorizationPolicy: (toolName) =>
        toolName === 'grep'
          ? { allowed: false, reason: '当前阶段禁止 grep' }
          : { allowed: true, reason: '' }
    })
    const results = await prepared.agentLoop.checkBatchPermission([
      { toolCallId: 'tc_grep', toolName: 'grep', args: { pattern: 'x' } },
      { toolCallId: 'tc_read', toolName: 'read', args: { path: 'a.ts' } }
    ], 'msg-child')
    expect(results.get('tc_grep')).toMatchObject({ allowed: false, reason: '当前阶段禁止 grep' })
    expect(results.get('tc_read')).toMatchObject({ allowed: true })
    dispose()
  })
})
