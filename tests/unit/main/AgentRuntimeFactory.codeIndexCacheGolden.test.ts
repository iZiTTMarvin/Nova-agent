import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { prepareAgentRuntime } from '../../../src/main/agent/runtime/AgentRuntimeFactory'
import { agentRoute } from '../../../src/runtime/agent/turn'
import { OpenAICompatibleModelClient } from '../../../src/runtime/model/OpenAICompatibleModelClient'
import type { ModelClient } from '../../../src/runtime/model/ModelClient'
import { computeWireSnapshot } from '../../../src/runtime/model/requestFingerprint'
import { createRunCoordinator } from '../../../src/runtime/run'
import { SessionStore } from '../../../src/runtime/sessions'
import type { SessionData } from '../../../src/runtime/sessions'
import type { ModelConfig } from '../../../src/shared/config'
import { LOAD_TOOLS_ACTIVATED_MARKER } from '../../../src/runtime/tools/availability'
import { renderXmlToolContracts } from '../../../src/runtime/agent'
import { MockModelClient } from '../../../src/test-support/builders/MockModelClient'
import { resetSessionIndexHostForTests } from '../../../src/runtime/sessions/SessionIndexHost'
import { DEFAULT_NOVA_SETTINGS } from '../../../src/runtime/settings/novaSettings'
import { ImageStore } from '../../../src/runtime/storage/ImageStore'
import { createReadState } from '../../../src/runtime/tools/editTool'
import { createEmptyCodeContextPack } from '../../../src/runtime/code-graph'
import type {
  CodeContextQueryPort,
  CodeIndexStatus
} from '../../../src/runtime/code-graph'
import type { NovaSettings } from '../../../src/runtime/settings/novaSettings'

vi.mock('electron', () => ({
  app: {
    getPath: () => tmpdir(),
    getAppPath: () => tmpdir()
  },
  protocol: {
    registerSchemesAsPrivileged: vi.fn()
  },
  BrowserWindow: class BrowserWindow {}
}))

vi.mock('../../../src/main/services/SkillServiceHost', () => ({
  getSkillService: () => ({
    getWorkspaceRoot: () => '/nova-code-graph-cache-golden',
    load: vi.fn(),
    getRegistry: () => ({
      listForContext: () => [],
      get: () => undefined,
      list: () => []
    })
  }),
  ensureSkillRegistryForWorkspace: () => ({
    listForContext: () => [],
    get: () => undefined,
    list: () => []
  })
}))

vi.mock('../../../src/main/services/WorkspaceService', () => ({
  getWorkspaceService: () => ({
    setMode: vi.fn(),
    refreshAvailableSessions: vi.fn()
  })
}))

vi.mock('../../../src/main/services/SubagentSchedulerHost', () => ({
  getSubagentScheduler: () => ({ enqueue: vi.fn() })
}))

// bash 描述按探测到的 shell 家族渲染（pwsh/cmd/POSIX），随机器环境漂移；
// golden 以常量锚定该段，家族渲染由 bash/prompt 自身测试保护
vi.mock('../../../src/runtime/tools/bash/prompt', () => ({
  renderBashDescription: () => '[golden] bash description'
}))

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function createCapturingClient(onBody: (body: Record<string, unknown>) => void) {
  return new OpenAICompatibleModelClient({
    baseUrl: 'https://cache-golden.invalid/v1',
    apiKey: 'test-key',
    modelId: 'cache-golden',
    cacheProfile: 'generic'
  }, {
    fetchImpl: async (_input, init) => {
      if (typeof init?.body !== 'string') {
        throw new Error('最终请求体不是 JSON 文本')
      }
      const parsed: unknown = JSON.parse(init.body)
      if (!isRecord(parsed)) throw new Error('最终请求体不是对象')
      onBody(parsed)

      const encoder = new TextEncoder()
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(
            encoder.encode('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n')
          )
          controller.enqueue(encoder.encode('data: [DONE]\n\n'))
          controller.close()
        }
      })
      return new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' }
      })
    }
  })
}

describe('AgentRuntimeFactory feature-off cache golden', () => {
  const roots: string[] = []

  afterEach(() => {
    resetSessionIndexHostForTests()
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  // 三种开发模式的最终请求字节基线；bash 描述锚定为常量、系统消息行尾统一 LF，
  // 未改变工具契约时，哈希变化应追查装配参数，不能直接更新期望值。
  it.each([
    ['default', { toolsHash: 'badf7deea56e86d6', systemContentHash: 'd0a519f7d119c855' }],
    ['plan', { toolsHash: '0668bfda5851b7c4', systemContentHash: '1ebaed93d050e4ff' }],
    ['pilot', { toolsHash: '8344955172c4a0bd', systemContentHash: '589eea2574b676c0' }]
  ] as const)('工具面和首条 system message 符合模式字节基线（%s）', async (mode, expected) => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'nova-code-graph-cache-golden-'))
    roots.push(sessionsDir)
    const workspaceRoot = '/nova-code-graph-cache-golden'
    const store = new SessionStore(sessionsDir)
    const session = store.create(workspaceRoot, mode)
    let wireBody: Record<string, unknown> | null = null
    const modelClient = createCapturingClient(body => {
      wireBody = body
    })
    const prepared = prepareAgentRuntime({
      session,
      sessionStore: store,
      sessionId: session.id,
      projectPath: workspaceRoot,
      sessionsDir,
      novaSettings: DEFAULT_NOVA_SETTINGS,
      modelClient,
      getImageStore: () => new ImageStore(sessionsDir),
      readState: createReadState(),
      pendingAskQuestions: new Map(),
      runCoordinator: createRunCoordinator(join(sessionsDir, 'runs'))
    })

    try {
      await prepared.agentLoop.sendMessage('cache golden', agentRoute())
      const body = wireBody
      if (!body) throw new Error('模型请求未发生')
      // 提示词正文运行时从仓库 markdown 读盘，行尾随 checkout 的 autocrlf
      // 配置漂移（本地 CRLF / actions/checkout 的 LF）；基线比较前统一行尾
      const normalizedBody = structuredClone(body)
      const messages = (normalizedBody.messages ?? []) as Array<{
        role: string
        content: unknown
      }>
      if (typeof messages[0]?.content === 'string') {
        messages[0] = { ...messages[0], content: messages[0].content.replace(/\r\n/g, '\n') }
      }
      const snapshot = computeWireSnapshot(normalizedBody, 'generic')

      expect({
        toolsHash: snapshot.toolsHash,
        systemContentHash: snapshot.messages[0]?.content
      }).toEqual(expected)
    } finally {
      prepared.agentLoop.dispose()
    }
  })

  it('会话创建后的工具面不随设置或查询端状态改变', async () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'nova-code-graph-session-snapshot-'))
    roots.push(sessionsDir)
    const workspaceRoot = '/nova-code-graph-session-snapshot'
    const store = new SessionStore(sessionsDir)
    const session = store.create(workspaceRoot, 'default', { codeIndexEnabled: true })
    let queryPort: CodeContextQueryPort | null = null

    const run = async (settings: NovaSettings) => {
      let wireBody: Record<string, unknown> | null = null
      const prepared = prepareAgentRuntime({
        session: store.load(session.id) ?? session,
        sessionStore: store,
        sessionId: session.id,
        projectPath: workspaceRoot,
        sessionsDir,
        novaSettings: settings,
        modelClient: createCapturingClient(body => {
          wireBody = body
        }),
        getImageStore: () => new ImageStore(sessionsDir),
        getCodeContextQueryPort: () => queryPort,
        readState: createReadState(),
        pendingAskQuestions: new Map(),
        runCoordinator: createRunCoordinator(join(sessionsDir, 'runs'))
      })
      try {
        await prepared.agentLoop.sendMessage('session snapshot', agentRoute())
        const body = wireBody
        if (!body) throw new Error('模型请求未发生')
        return {
          snapshot: computeWireSnapshot(body, 'generic'),
          definition: prepared.toolRegistry.getToolDefinitions().find(
            definition => definition.name === 'code_context'
          )
        }
      } finally {
        prepared.agentLoop.dispose()
      }
    }

    const enabledSettings = { ...DEFAULT_NOVA_SETTINGS, codeIndexEnabled: true }
    const statuses: readonly CodeIndexStatus[] = [
      'building',
      'ready',
      'degraded',
      'unavailable'
    ]
    const results = []
    for (const status of statuses) {
      queryPort = {
        query: async () => createEmptyCodeContextPack({
          status,
          intent: 'locate',
          summary: `${status} · locate · test`,
          warnings: []
        })
      }
      results.push(await run({
        ...enabledSettings,
        codeIndexEnabled: status === 'building'
      }))
    }

    const first = results[0]
    if (!first) throw new Error('缺少工具面快照')
    expect(first.definition).toBeDefined()
    for (const result of results.slice(1)) {
      expect(result.definition).toEqual(first.definition)
      expect(result.snapshot.toolsHash).toBe(first.snapshot.toolsHash)
      expect(result.snapshot.messages[0]?.content).toBe(first.snapshot.messages[0]?.content)
    }
  })
})

function prepareCacheRuntime(
  session: SessionData,
  sessionStore: SessionStore,
  sessionsDir: string,
  toolDialect: 'native' | 'xml',
  modelClient: ModelClient = createCapturingClient(() => {})
) {
  const modelConfig: ModelConfig = {
    baseUrl: 'https://cache-golden.invalid/v1',
    apiKey: 'test-key',
    modelId: 'cache-golden',
    cacheProfile: 'generic',
    toolDialect
  }
  return prepareAgentRuntime({
    session,
    sessionStore,
    sessionId: session.id,
    projectPath: session.workspaceRoot,
    sessionsDir,
    novaSettings: DEFAULT_NOVA_SETTINGS,
    modelClient,
    modelConfig,
    getImageStore: () => new ImageStore(sessionsDir),
    readState: createReadState(),
    pendingAskQuestions: new Map(),
    runCoordinator: createRunCoordinator(join(sessionsDir, 'runs'))
  })
}

describe('AgentRuntimeFactory 动态工具披露与恢复', () => {
  const roots: string[] = []
  const originalEconomy = process.env.NOVA_TOOL_ECONOMY

  beforeEach(() => {
    process.env.NOVA_TOOL_ECONOMY = 'on'
  })

  afterEach(() => {
    if (originalEconomy === undefined) delete process.env.NOVA_TOOL_ECONOMY
    else process.env.NOVA_TOOL_ECONOMY = originalEconomy
    resetSessionIndexHostForTests()
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  function createSession(mode: 'default' | 'plan' = 'default') {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'nova-tool-disclosure-cache-'))
    roots.push(sessionsDir)
    const store = new SessionStore(sessionsDir)
    const session = store.create('/nova-tool-disclosure-cache', mode)
    return { sessionsDir, store, session }
  }

  it('Plan 模式的激活结果不披露编排工具调用契约', async () => {
    const { sessionsDir, store, session } = createSession('plan')
    const client = new MockModelClient()
    client.addResponse({
      events: [
        { type: 'message_start' },
        {
          type: 'text_delta',
          delta: '<invoke name="load_tools"><parameter name="group">agent</parameter></invoke>'
        },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'text_delta', delta: '完成' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })
    const prepared = prepareCacheRuntime(session, store, sessionsDir, 'xml', client)
    try {
      await prepared.agentLoop.sendMessage('加载工具', agentRoute())
      const toolResult = client.getCalls()[1]?.messages.find(message => message.role === 'tool')
      expect(toolResult?.content).toContain(LOAD_TOOLS_ACTIVATED_MARKER)
      expect(toolResult?.content).not.toContain('<invoke name="task"')
    } finally {
      prepared.agentLoop.dispose()
    }
  })

  it('运行中切入 Plan 后激活结果按当前 mode 收窄', async () => {
    const { sessionsDir, store, session } = createSession('default')
    const client = new MockModelClient()
    client.addResponse({
      events: [
        { type: 'message_start' },
        {
          type: 'text_delta',
          delta: '<invoke name="load_tools"><parameter name="group">agent</parameter></invoke>'
        },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'text_delta', delta: '完成' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })
    const prepared = prepareCacheRuntime(session, store, sessionsDir, 'xml', client)
    try {
      prepared.agentLoop.setMode('plan')
      await prepared.agentLoop.sendMessage('加载工具', agentRoute())
      const toolResult = client.getCalls()[1]?.messages.find(message => message.role === 'tool')
      expect(toolResult?.content).toContain(LOAD_TOOLS_ACTIVATED_MARKER)
      expect(toolResult?.content).not.toContain('<invoke name="task"')
    } finally {
      prepared.agentLoop.dispose()
    }
  })

  it('非工具层内容过期时不复用旧 frozen prompt', () => {
    const { sessionsDir, store, session } = createSession()
    const first = prepareCacheRuntime(session, store, sessionsDir, 'native')
    const expected = first.frozenPrompt
    session.frozenSystemPrompt = `${expected}\n\nSTALE_NON_TOOL_LAYER`
    store.save(session)
    first.agentLoop.dispose()

    const restored = store.load(session.id)
    if (!restored) throw new Error('会话恢复失败')
    const second = prepareCacheRuntime(restored, store, sessionsDir, 'native')
    try {
      expect(second.frozenPrompt).toBe(expected)
      expect(second.frozenPrompt).not.toContain('STALE_NON_TOOL_LAYER')
    } finally {
      second.agentLoop.dispose()
    }
  })

  it('只有 invoke 字样的历史不能代替完整激活契约', () => {
    const { sessionsDir, store, session } = createSession()
    const first = prepareCacheRuntime(session, store, sessionsDir, 'xml')
    session.frozenSystemPrompt = first.frozenPrompt
    store.save(session)
    first.agentLoop.dispose()

    store.updateToolAvailability(session.id, { version: 2, activatedGroups: ['agent'] })
    store.appendMessage(session.id, {
      id: 'load-call',
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'load-call-1', name: 'load_tools', arguments: '{"group":"agent"}' }],
      timestamp: 1
    })
    const fakeInvocations = ['task', 'task_followup', 'task_wait', 'subagent_read', 'batch_task']
      .map(name => `<invoke name="${name}"></invoke>`)
      .join('\n')
    store.appendMessage(session.id, {
      id: 'load-result',
      role: 'tool',
      toolCallId: 'load-call-1',
      content: `${LOAD_TOOLS_ACTIVATED_MARKER}agent\n${fakeInvocations}`,
      timestamp: 2
    })

    const restored = store.load(session.id)
    if (!restored) throw new Error('会话恢复失败')
    const second = prepareCacheRuntime(restored, store, sessionsDir, 'xml')
    try {
      expect(second.frozenPrompt).toContain('### task')
      expect(second.frozenPrompt).toContain('<invoke name="task"')
    } finally {
      second.agentLoop.dispose()
    }
  })

  it('旧 XML 禁止规则即使带有工具示例也必须升级', () => {
    const { sessionsDir, store, session } = createSession()
    session.toolAvailability = { version: 2, activatedGroups: ['agent'] }
    store.save(session)
    const first = prepareCacheRuntime(session, store, sessionsDir, 'xml')
    expect(first.frozenPrompt).toContain('### task')
    const legacyPrompt = first.frozenPrompt.replace(
      'or a tool later activated by a successful load_tools call whose result included the full calling contract.',
      'never call unlisted tools.'
    )
    first.agentLoop.dispose()
    expect(legacyPrompt).toContain('never call unlisted tools.')
    session.frozenSystemPrompt = legacyPrompt
    store.save(session)

    const restored = store.load(session.id)
    if (!restored) throw new Error('会话恢复失败')
    const second = prepareCacheRuntime(restored, store, sessionsDir, 'xml')
    try {
      expect(second.frozenPrompt).toContain('or a tool later activated by a successful load_tools call')
      expect(second.frozenPrompt).not.toContain('never call unlisted tools.')
    } finally {
      second.agentLoop.dispose()
    }
  })

  it('完整恢复目录之后新增组只消费追加契约，不重写 frozen prompt', () => {
    const { sessionsDir, store, session } = createSession()
    session.toolAvailability = { version: 2, activatedGroups: ['agent'] }
    store.save(session)
    const first = prepareCacheRuntime(session, store, sessionsDir, 'xml')
    const frozen = first.frozenPrompt
    expect(frozen).toContain('### task')
    const browserContract = renderXmlToolContracts(
      first.toolRegistry.getToolDefinitions().filter(def => def.name.startsWith('browser_'))
    )
    first.agentLoop.dispose()
    session.frozenSystemPrompt = frozen
    store.save(session)
    store.updateToolAvailability(session.id, { version: 2, activatedGroups: ['agent', 'browser'] })
    store.appendMessage(session.id, {
      id: 'browser-disclosure',
      role: 'tool',
      toolCallId: 'browser-load-call',
      content: browserContract,
      timestamp: 1
    })

    const restored = store.load(session.id)
    if (!restored) throw new Error('会话恢复失败')
    const second = prepareCacheRuntime(restored, store, sessionsDir, 'xml')
    try {
      expect(second.frozenPrompt).toBe(frozen)
      expect(second.agentLoop.getCacheDiagnosticObservation().epochId).toBe('epoch_0')
    } finally {
      second.agentLoop.dispose()
    }
  })

  it('旧 compose 冻结提示词在恢复时归一为 pilot，不把 XForge 说明带给模型', () => {
    const { sessionsDir, store, session } = createSession()
    const first = prepareCacheRuntime(session, store, sessionsDir, 'native')
    const legacy = first.frozenPrompt.replace(
      '- pilot — Nova pilot: organizes development with the built-in pilot method and grounds delivery in real artifacts.',
      '- compose — XForge staged delivery: interview, one-pager, independent critique, build, independent inspection, plain-language wrap-up.'
    )
    expect(legacy).not.toBe(first.frozenPrompt)
    first.agentLoop.dispose()
    session.frozenSystemPrompt = legacy
    store.save(session)

    const restored = store.load(session.id)
    if (!restored) throw new Error('会话恢复失败')
    const second = prepareCacheRuntime(restored, store, sessionsDir, 'native')
    try {
      expect(second.frozenPrompt).toContain('- pilot — Nova pilot:')
      expect(second.frozenPrompt).not.toContain('XForge')
      expect(second.frozenPrompt).not.toContain('- compose —')
      // 只替换已知模式行，内容与当前稳定提示词一致，不需要重建 epoch
      expect(second.agentLoop.getCacheDiagnosticObservation().epochId).toBe('epoch_0')
    } finally {
      second.agentLoop.dispose()
    }
  })

  it('已有 frozen prompt 在 Native 与 XML 之间切换时按当前方言重建', () => {
    const { sessionsDir, store, session } = createSession()
    const first = prepareCacheRuntime(session, store, sessionsDir, 'native')
    session.frozenSystemPrompt = first.frozenPrompt
    store.save(session)
    first.agentLoop.dispose()

    const restored = store.load(session.id)
    if (!restored) throw new Error('会话恢复失败')
    const second = prepareCacheRuntime(restored, store, sessionsDir, 'xml')
    try {
      expect(second.frozenPrompt).toContain('## Tool catalog (XML inband calls)')
    } finally {
      second.agentLoop.dispose()
    }
  })

  it('economy 与 mode 变化时不复用能力目录不一致的 frozen prompt', () => {
    const { sessionsDir, store, session } = createSession()
    process.env.NOVA_TOOL_ECONOMY = 'off'
    const first = prepareCacheRuntime(session, store, sessionsDir, 'native')
    expect(first.frozenPrompt).not.toContain('Tool groups load on demand')
    expect(first.frozenPrompt).toContain('- task')
    session.frozenSystemPrompt = first.frozenPrompt
    store.save(session)
    first.agentLoop.dispose()

    process.env.NOVA_TOOL_ECONOMY = 'on'
    const secondSession = store.load(session.id)
    if (!secondSession) throw new Error('会话恢复失败')
    const second = prepareCacheRuntime(secondSession, store, sessionsDir, 'native')
    expect(second.frozenPrompt).toContain('Tool groups load on demand')
    expect(second.frozenPrompt).not.toContain('- task')
    secondSession.frozenSystemPrompt = second.frozenPrompt
    store.save(secondSession)
    second.agentLoop.dispose()

    store.updateMode(session.id, 'plan')
    const thirdSession = store.load(session.id)
    if (!thirdSession) throw new Error('会话恢复失败')
    const third = prepareCacheRuntime(thirdSession, store, sessionsDir, 'native')
    expect(third.frozenPrompt).not.toContain('- write')
    thirdSession.frozenSystemPrompt = third.frozenPrompt
    store.save(thirdSession)
    third.agentLoop.dispose()

    store.updateMode(session.id, 'default')
    process.env.NOVA_TOOL_ECONOMY = 'off'
    const fourthSession = store.load(session.id)
    if (!fourthSession) throw new Error('会话恢复失败')
    const fourth = prepareCacheRuntime(fourthSession, store, sessionsDir, 'native')
    try {
      expect(fourth.frozenPrompt).not.toContain('Tool groups load on demand')
      expect(fourth.frozenPrompt).toContain('- task')
    } finally {
      fourth.agentLoop.dispose()
    }
  })

  it('v1 能从消息恢复顺序时也显式切换旧工具面 epoch', () => {
    const { sessionsDir, store, session } = createSession()
    store.appendMessage(session.id, {
      id: 'load-call',
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'load-call-1', name: 'load_tools', arguments: '{"group":"agent"}' }],
      timestamp: 1
    })
    store.appendMessage(session.id, {
      id: 'load-result',
      role: 'tool',
      toolCallId: 'load-call-1',
      content: LOAD_TOOLS_ACTIVATED_MARKER + 'agent',
      timestamp: 2
    })
    store.updateToolAvailability(session.id, { version: 1, activatedGroups: ['agent'] })

    const restored = store.load(session.id)
    if (!restored) throw new Error('会话恢复失败')
    const prepared = prepareCacheRuntime(restored, store, sessionsDir, 'native')
    try {
      expect(prepared.agentLoop.getCacheDiagnosticObservation().epochId).toBe('epoch_1')
      expect(prepared.agentLoop.getCacheDiagnosticObservation().epochReason).toBe('session_init')
    } finally {
      prepared.agentLoop.dispose()
    }
  })
})
