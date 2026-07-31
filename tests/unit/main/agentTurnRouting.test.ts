/**
 * AgentTurnService 路由行为级集成测试。
 * 真实执行 sendAgentMessage，观察 startRun / appendMessageFast 的调用，
 * 证明 compose 与 default 都沿普通 AgentLoop durable run 进入执行。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'

// ---- hoisted mocks：服务宿主与运行时装配 ----
const coordinator = vi.hoisted(() => ({
  listActiveRuns: vi.fn(() => [] as any[]),
  getSnapshotForSession: vi.fn(() => null),
  getSnapshot: vi.fn(() => ({ status: 'running' })),
  startRun: vi.fn((params: any) => ({ runId: `run-${params.kind}`, kind: params.kind, status: 'queued' })),
  transition: vi.fn(),
  markRunning: vi.fn(),
  commitTerminal: vi.fn(),
  bindExecutionGeneration: vi.fn(),
  isExecutionCurrent: vi.fn(() => true),
  touchHeartbeat: vi.fn(),
  getStallLiveness: vi.fn(() => null),
  inbox: { enqueue: vi.fn(() => ({ interactionId: 'i', version: 1 })), cancelAllForRun: vi.fn() },
  onTerminalHook: vi.fn()
}))
const executionRegistry = vi.hoisted(() => ({
  register: vi.fn(),
  unregister: vi.fn()
}))

// 捕获 sendAgentMessage 实际传给 AgentLoop.sendMessage 的 route
const sentRoutes = vi.hoisted(() => [] as any[])
const stubAgentLoop = vi.hoisted(() => ({
  setRunRef: vi.fn(),
  setExecutionFence: vi.fn(),
  cancel: vi.fn(),
  dispose: vi.fn(),
  getHookManager: vi.fn(() => ({ trigger: vi.fn() })),
  sendMessage: vi.fn(async (_content: any, route: any) => {
    sentRoutes.push(route)
    return { status: 'completed' }
  })
}))

// 每个用例可替换的 skillRegistry（决定 slash 解析结果）
const registryHolder = vi.hoisted(() => ({ current: null as any }))

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/nova-test-userdata') },
  BrowserWindow: class BrowserWindow {}
}))

vi.mock('../../../src/main/services/RunCoordinatorHost', () => ({
  getRunCoordinator: () => coordinator,
  getRunExecutionRegistry: () => executionRegistry,
  setActiveRunId: vi.fn()
}))

vi.mock('../../../src/main/services/WorkspaceService', () => ({
  getWorkspaceService: () => ({ refreshAvailableSessions: vi.fn(), setMode: vi.fn() })
}))

vi.mock('../../../src/main/services/MemoryConsolidationHost', () => ({
  ensureObservationCaptureForSession: vi.fn()
}))
vi.mock('../../../src/shared/config/types', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/shared/config/types')>()
  return { ...actual, resolveSupportsVision: vi.fn(() => true) }
})

vi.mock('../../../src/main/services/SessionStoreHost', () => ({
  getSessionStore: () => sessionStore
}))


vi.mock('../../../src/main/services/MemoryExtractHost', () => ({
  onUserTurnCompleteForExtract: vi.fn()
}))

vi.mock('../../../src/main/agent/state', () => ({
  getReadStateForSession: vi.fn(() => ({})),
  isSessionTurnInProgress: vi.fn(() => false)
}))

vi.mock('../../../src/main/agent/events', () => ({
  accumulateStreamEvent: vi.fn(),
  disposeTurnStreams: vi.fn(),
  forwardEventToRenderer: vi.fn(),
  activeStreams: new Map()
}))

vi.mock('../../../src/main/agent/interaction/askQuestionWaiters', () => ({
  pendingAskQuestions: new Map(),
  dismissPendingAskQuestionsForSession: vi.fn()
}))

vi.mock('../../../src/runtime/memory/MemoryObservationBridge', () => ({
  subscribeObservationCapture: vi.fn()
}))

vi.mock('../../../src/runtime/model/config', () => ({
  loadModelConfig: vi.fn(() => ({ modelId: 'test-model' }))
}))

vi.mock('../../../src/runtime/settings/novaSettings', () => ({
  loadNovaSettings: vi.fn(() => ({
    permissionPolicy: 'auto',
    memoryEnabled: false,
    maxToolRounds: 20
  }))
}))

vi.mock('../../../src/runtime/settings/syncTavilyApiKey', () => ({
  syncTavilyApiKeyFromSettings: vi.fn()
}))

vi.mock('../../../src/shared/diagnostics/stallDetector', () => ({
  createEventStallDetector: vi.fn(() => vi.fn())
}))

vi.mock('../../../src/main/agent/runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/main/agent/runtime')>()
  return {
    ...actual,
    USE_UNIFIED_SKILL_DISPATCH: true,
    resolveToDataUrl: vi.fn((_store: any, url: string) => url),
    prepareAgentRuntime: vi.fn(() => ({
      agentLoop: stubAgentLoop,
      eventBus: { on: vi.fn() },
      modelPool: {},
      runRefs: { runId: '', executionGeneration: 0 },
      frozenPrompt: 'system',
      skillRegistry: registryHolder.current
    }))
  }
})

import { sendAgentMessage } from '../../../src/main/agent/turn/AgentTurnService'
import { SkillRegistry } from '../../../src/runtime/skills/SkillRegistry'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function createRegistry(skills: Array<{ name: string; workflow?: string }>): SkillRegistry {
  const root = mkdtempSync(join(tmpdir(), 'nova-turn-svc-'))
  roots.push(root)
  const skillsDir = join(root, 'skills')
  for (const s of skills) {
    const dir = join(skillsDir, s.name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), [
      '---',
      `name: ${s.name}`,
      `description: ${s.name} skill`,
      'user-invocable: true',
      ...(s.workflow ? [`workflow: ${s.workflow}`] : []),
      '---',
      `Body of ${s.name}.`
    ].join('\n'))
  }
  return SkillRegistry.load({ globalDir: skillsDir })
}

function makeSession(mode: 'default' | 'compose' = 'default') {
  return {
    id: 'sess-1',
    mode,
    workspaceRoot: '/tmp/ws',
    messages: [],
    schemaVersion: 2,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    currentLeafId: null,
    frozenSystemPrompt: ''
  }
}

const sessionStore = {
  load: vi.fn(() => makeSession()),
  save: vi.fn(),
  getSessionsDir: vi.fn(() => '/tmp/sessions'),
  ensureCacheRoutingKey: vi.fn(() => null),
  appendMessageFast: vi.fn(() => ({ ok: true })),
  updateTitle: vi.fn(() => false),
  addGrantedSkillRoot: vi.fn(),
  loadContextSnapshot: vi.fn(() => null)
}

const deps = {
  getMainWindow: () => null,
  getModelClient: () => ({} as any),
  getImageStore: () => ({ read: vi.fn() } as any)
}

beforeEach(() => {
  vi.clearAllMocks()
  sentRoutes.length = 0
  registryHolder.current = null
  coordinator.listActiveRuns.mockReturnValue([])
  coordinator.getSnapshotForSession.mockReturnValue(null)
  coordinator.getSnapshot.mockReturnValue({ status: 'running' })
  sessionStore.load.mockReturnValue(makeSession())
})

describe('sendAgentMessage 路由行为级集成', () => {
  it('compose + 普通文本 → 创建 agent run，且 route 传给 sendMessage', async () => {
    registryHolder.current = createRegistry([])
    sessionStore.load.mockReturnValue(makeSession('compose'))

    await sendAgentMessage({ sessionId: 'sess-1', content: '实现登录功能' }, deps)

    expect(coordinator.startRun).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'agent' })
    )
    expect(sentRoutes).toHaveLength(1)
    expect(sentRoutes[0]).toEqual({ kind: 'agent', dispatch: { kind: 'passthrough' } })
  })

  it('compose + Legacy Workflow → 仍创建 agent run', async () => {
    registryHolder.current = createRegistry([{ name: 'legacy-flow', workflow: 'legacy-flow' }])
    sessionStore.load.mockReturnValue(makeSession('compose'))

    await sendAgentMessage({ sessionId: 'sess-1', content: '/legacy-flow 继续旧编排' }, deps)

    expect(coordinator.startRun).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'agent' })
    )
    expect(sentRoutes[0]).toEqual({ kind: 'agent', dispatch: { kind: 'passthrough' } })
  })

  it('default + 普通文本 → 创建 agent run', async () => {
    registryHolder.current = createRegistry([])
    sessionStore.load.mockReturnValue(makeSession('default'))

    await sendAgentMessage({ sessionId: 'sess-1', content: '帮我写个函数' }, deps)

    expect(coordinator.startRun).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'agent' })
    )
    expect(sentRoutes[0].kind).toBe('agent')
  })

  it('compose 图片消息 → 创建 agent run', async () => {
    registryHolder.current = createRegistry([])
    sessionStore.load.mockReturnValue(makeSession('compose'))

    await sendAgentMessage({
      sessionId: 'sess-1',
      content: '看这张图',
      images: [{ fileName: 'a.png', data: 'nova-image://a', mimeType: 'image/png' }]
    }, deps)

    expect(coordinator.startRun).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'agent' })
    )
    expect(sentRoutes[0].kind).toBe('agent')
  })

  it('compose + 工作区已有旧 run → 不触发旧执行器分支', async () => {
    registryHolder.current = createRegistry([])
    sessionStore.load.mockReturnValue(makeSession('compose'))
    coordinator.listActiveRuns.mockReturnValue([
      { runId: 'existing', kind: 'xforge', workspaceId: '/tmp/ws', status: 'running' }
    ])

    await sendAgentMessage({ sessionId: 'sess-1', content: '实现登录功能' }, deps)

    expect(sessionStore.appendMessageFast).toHaveBeenCalledTimes(1)
    expect(coordinator.startRun).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'agent' })
    )
  })

  it('default 模式触发同一 Legacy Workflow 不受 XForge 并发限制', async () => {
    registryHolder.current = createRegistry([{ name: 'legacy-flow', workflow: 'legacy-flow' }])
    sessionStore.load.mockReturnValue(makeSession('default'))
    // 工作区已有旧 run 不改变 default 的普通路由。
    coordinator.listActiveRuns.mockReturnValue([
      { runId: 'existing', kind: 'xforge', workspaceId: '/tmp/ws', status: 'running' }
    ])

    await sendAgentMessage({ sessionId: 'sess-1', content: '/legacy-flow 做事' }, deps)

    expect(coordinator.startRun).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'agent' })
    )
    expect(sessionStore.appendMessageFast).toHaveBeenCalledTimes(1)
  })

  it('用户消息落盘发生在 startRun 之前', async () => {
    registryHolder.current = createRegistry([])
    sessionStore.load.mockReturnValue(makeSession('default'))
    const order: string[] = []
    sessionStore.appendMessageFast.mockImplementation(() => {
      order.push('append')
      return { ok: true }
    })
    coordinator.startRun.mockImplementation((params: any) => {
      order.push('startRun')
      return { runId: 'run-agent', kind: params.kind, status: 'queued' }
    })

    await sendAgentMessage({ sessionId: 'sess-1', content: '你好' }, deps)

    expect(order).toEqual(['append', 'startRun'])
  })
})
