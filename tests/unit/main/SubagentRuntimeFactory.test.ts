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
import { OpenAICompatibleModelClient } from '../../../src/runtime/model/OpenAICompatibleModelClient'
import type { LlmRegistry } from '../../../src/shared/config/llmRegistry'
import type { SubagentSessionHeader } from '../../../src/shared/subagents'

const testRegistry: LlmRegistry = {
  version: 2,
  activeModel: { providerId: 'test-provider', modelEntryId: 'test-entry' },
  providers: [{
    id: 'test-provider',
    name: 'Test provider',
    baseUrl: 'https://test.invalid/v1',
    apiKey: 'test-key',
    enabled: true,
    models: [{ id: 'test-entry', modelId: 'test-model', contextWindow: 32_000, supportsVision: false }]
  }]
}

const testHeader: SubagentSessionHeader = {
  providerId: 'test-provider',
  modelEntryId: 'test-entry',
  modelId: 'test-model',
  reasoningEffort: 'auto'
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

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
        header: testHeader,
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
          id: 'skill:inspect',
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
      registry: testRegistry,
      resolveTool: () => undefined,
      sessionStore: store,
      sessionsDir,
      novaSettings: DEFAULT_NOVA_SETTINGS,
      readState: createReadState()
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
    vi.spyOn(OpenAICompatibleModelClient.prototype, 'chat').mockImplementation(client.chat.bind(client))
    const enabled = prepareSubagentRuntime({
      profile: reloaded.subagent.profile,
      task: 'inspect',
      workingDirectory: workspace,
      isolation: 'readonly',
      childSession: reloaded,
      parentRunId: 'run-parent',
      rootRunId: 'run-parent',
      registry: testRegistry,
      resolveTool: (name) => name === 'code_context' ? codeContextTool : undefined,
      sessionStore: store,
      sessionsDir,
      novaSettings: DEFAULT_NOVA_SETTINGS,
      readState: createReadState()
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
      id: profileId,
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
        header: testHeader,
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
      registry: testRegistry,
      resolveTool,
      sessionStore: store,
      sessionsDir,
      readState: createReadState(),
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

describe('SubagentRuntimeFactory 模型请求', () => {
  const roots: string[] = []

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  it('两个 child 按持久化 header 使用独立模型与 effort，保留各自视觉能力和上下文窗口', async () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'nova-subagent-wire-'))
    roots.push(sessionsDir)
    const workspace = resolve(sessionsDir, 'workspace')
    const store = new SessionStore(sessionsDir)
    const parent = store.create(workspace)
    store.updateReasoningEffortOverride(parent.id, 'max')
    const registry: LlmRegistry = {
      ...testRegistry,
      providers: [
        ...testRegistry.providers,
        {
          id: 'child-a', name: 'Child A', baseUrl: 'https://child-a.invalid/v1',
          apiKey: 'test-child-a', enabled: true, toolDialect: 'native',
          models: [{
            id: 'entry-a', modelId: 'model-a', reasoningEffort: 'low',
            contextWindow: 48_000, supportsVision: true
          }]
        },
        {
          id: 'child-b', name: 'Child B', baseUrl: 'https://child-b.invalid/v1',
          apiKey: 'test-child-b', enabled: true, toolDialect: 'native',
          models: [{
            id: 'entry-b', modelId: 'model-b', reasoningEffort: 'high',
            contextWindow: 64_000, supportsVision: false
          }]
        }
      ],
      fallbacks: [testRegistry.activeModel]
    }
    const requests: Array<{ url: string; body: unknown }> = []
    vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => {
      if (typeof init?.body !== 'string') throw new Error('expected serialized model body')
      const body: unknown = JSON.parse(init.body)
      requests.push({ url: String(url), body })
      return new Response(
        'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":20,"completion_tokens":1}}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
      )
    })
    const headers: SubagentSessionHeader[] = [
      { providerId: 'child-a', modelEntryId: 'entry-a', modelId: 'model-a', reasoningEffort: 'high' },
      { providerId: 'child-b', modelEntryId: 'entry-b', modelId: 'model-b', reasoningEffort: 'auto' }
    ]
    const children = headers.map((header, index) => {
      const profile = resolveSubagentProfileSnapshot({
        id: 'inspect',
        name: 'inspect', description: 'Inspect', prompt: 'Inspect', allowedTools: [],
        contextWindow: index === 0 ? 24_000 : 100_000
      }, 'inspect')
      const child = store.createChildIfAbsent({
        workspaceRoot: workspace, mode: 'default', permissionMode: 'request_approval', task: 'inspect',
        subagent: {
          header, profile,
          lineage: {
            parentSessionId: parent.id, parentRunId: 'run-parent', rootRunId: 'run-parent',
            depth: 1, spawnKey: `wire-${index}`, spawnRunId: `run-child-${index}`,
            origin: { kind: 'task_tool', parentMessageId: 'message-parent', parentToolCallId: `call-${index}` }
          }
        }
      }).session
      const restored = new SessionStore(sessionsDir).load(child.id)
      if (!restored || restored.kind !== 'subagent') throw new Error('expected persisted child')
      const prepared = prepareSubagentRuntime({
        profile, childSession: restored, task: 'inspect', workingDirectory: workspace,
        isolation: 'readonly', parentRunId: 'run-parent', rootRunId: 'run-parent',
        registry, resolveTool: () => undefined, sessionStore: store, sessionsDir,
        readState: createReadState(), novaSettings: DEFAULT_NOVA_SETTINGS
      })
      prepared.agentLoop.setRunRef(`run-child-${index}`)
      const limits: number[] = []
      prepared.eventBus.on((event) => {
        if (event.type === 'context_breakdown' && event.contextLimit !== undefined) limits.push(event.contextLimit)
      })
      return { prepared, limits }
    })
    try {
      const outcomes = await Promise.all(children.map(({ prepared }) => prepared.agentLoop.sendMessage([
        { type: 'text', text: 'inspect' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AQID' } }
      ], agentRoute())))
      expect(outcomes.map((outcome) => outcome.status)).toEqual(['completed', 'completed'])
      expect(requests).toHaveLength(2)
      const requestA = requests.find((request) => request.url.startsWith('https://child-a.invalid/'))
      const requestB = requests.find((request) => request.url.startsWith('https://child-b.invalid/'))
      expect(requestA).toMatchObject({
        url: 'https://child-a.invalid/v1/chat/completions',
        body: { model: 'model-a', reasoning_effort: 'high' }
      })
      expect(requestB).toMatchObject({
        url: 'https://child-b.invalid/v1/chat/completions', body: { model: 'model-b' }
      })
      expect(requestB?.body).not.toHaveProperty('reasoning_effort')
      expect(JSON.stringify(requestA?.body)).toContain('data:image/png;base64,AQID')
      expect(JSON.stringify(requestB?.body)).not.toContain('data:image/png;base64,AQID')
      expect(children[0].limits).toContain(24_000)
      expect(children[1].limits).toContain(64_000)
    } finally {
      children.forEach(({ prepared }) => prepared.agentLoop.dispose())
    }
  })
})
