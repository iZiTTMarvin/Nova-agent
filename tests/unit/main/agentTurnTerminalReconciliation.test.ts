/**
 * AgentTurnService 终态对账行为级测试。
 * 真实执行 sendAgentMessage，用 stub AgentLoop 返回结构化 outcome，
 * 证明 durable 终态由 outcome 驱动提交，且 XForge waiting/终态权威状态不被覆盖。
 */
import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'

// ---- hoisted mocks：服务宿主与运行时装配 ----
const snapHolder = vi.hoisted(() => ({
  current: { runId: 'run-agent', kind: 'agent', status: 'running' } as Record<string, unknown> | null
}))
const coordinator = vi.hoisted(() => ({
  listActiveRuns: vi.fn(() => [] as any[]),
  getSnapshotForSession: vi.fn(() => null),
  getSnapshot: vi.fn(() => snapHolder.current),
  startRun: vi.fn((params: any) => ({ runId: 'run-agent', kind: params.kind, status: 'queued' })),
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
const stageCommitter = vi.hoisted(() => ({
  commitXForgeStageTransition: vi.fn(() => ({ ok: true }))
}))
const xforgeService = vi.hoisted(() => ({
  startXForgeRun: vi.fn(() => ({ runId: 'run-xforge', kind: 'xforge', status: 'queued' })),
  resumeXForgeRun: vi.fn(),
  createExecutionCommitter: vi.fn(() => stageCommitter)
}))
const executionRegistry = vi.hoisted(() => ({
  hasUnsettledHandle: vi.fn(() => false),
  register: vi.fn(),
  unregister: vi.fn()
}))
const extractSpy = vi.hoisted(() => vi.fn())

// 每个用例可替换的 skillRegistry（compose 自然语言 → xforge route 需要非空 registry）
const registryHolder = vi.hoisted(() => ({ current: null as any }))

const stubAgentLoop = vi.hoisted(() => ({
  setRunRef: vi.fn(),
  setExecutionFence: vi.fn(),
  cancel: vi.fn(),
  dispose: vi.fn(),
  getHookManager: vi.fn(() => ({ trigger: vi.fn() })),
  sendMessage: vi.fn(async () => ({ status: 'completed' }))
}))

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/nova-test-userdata') },
  BrowserWindow: class BrowserWindow {}
}))

vi.mock('../../../src/main/services/RunCoordinatorHost', () => ({
  getRunCoordinator: () => coordinator,
  getXForgeRunService: () => xforgeService,
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
  onUserTurnCompleteForExtract: extractSpy
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
      runRefs: { runId: '', executionGeneration: 0, resumableXForge: false },
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

function createEmptyRegistry(): SkillRegistry {
  const root = mkdtempSync(join(tmpdir(), 'nova-turn-terminal-'))
  roots.push(root)
  const skillsDir = join(root, 'skills')
  mkdirSync(skillsDir, { recursive: true })
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
    frozenSystemPrompt: 'system'
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
  snapHolder.current = { runId: 'run-agent', kind: 'agent', status: 'running' }
  registryHolder.current = null
  coordinator.listActiveRuns.mockReturnValue([])
  coordinator.getSnapshotForSession.mockReturnValue(null)
  sessionStore.load.mockReturnValue(makeSession())
  stubAgentLoop.sendMessage.mockResolvedValue({ status: 'completed' })
  xforgeService.createExecutionCommitter.mockReturnValue(stageCommitter)
})

describe('agent/compose run 按 outcome 提交终态', () => {
  it('outcome completed → commitTerminal completed', async () => {
    await sendAgentMessage({ sessionId: 'sess-1', content: '你好' }, deps)

    expect(coordinator.commitTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run-agent', status: 'completed' })
    )
  })

  it('outcome cancelled → commitTerminal cancelled', async () => {
    stubAgentLoop.sendMessage.mockResolvedValue({ status: 'cancelled' })

    await sendAgentMessage({ sessionId: 'sess-1', content: '你好' }, deps)

    expect(coordinator.commitTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run-agent', status: 'cancelled' })
    )
  })

  it('outcome failed → commitTerminal failed 并携带原始错误', async () => {
    stubAgentLoop.sendMessage.mockResolvedValue({
      status: 'failed',
      error: new Error('模型崩了')
    })

    await sendAgentMessage({ sessionId: 'sess-1', content: '你好' }, deps)

    expect(coordinator.commitTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run-agent', status: 'failed', reason: '模型崩了' })
    )
  })

  it('durable 已进入 cancelling 时 completed 让位于 cancelled', async () => {
    snapHolder.current = { runId: 'run-agent', kind: 'agent', status: 'cancelling' }

    await sendAgentMessage({ sessionId: 'sess-1', content: '你好' }, deps)

    expect(coordinator.commitTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run-agent', status: 'cancelled' })
    )
  })

  it('snapshot 已是硬终态时不再提交（不覆盖既有终态）', async () => {
    snapHolder.current = { runId: 'run-agent', kind: 'agent', status: 'completed' }

    await sendAgentMessage({ sessionId: 'sess-1', content: '你好' }, deps)

    expect(coordinator.commitTerminal).not.toHaveBeenCalled()
  })
})

describe('XForge run 的权威状态与 fail closed', () => {
  function makeXForgeSnap(status: string, currentStage = 'implement') {
    return {
      runId: 'run-xforge',
      kind: 'xforge',
      status,
      xforge: { currentStage }
    }
  }

  beforeEach(() => {
    sessionStore.load.mockReturnValue(makeSession('compose'))
    registryHolder.current = createEmptyRegistry()
    snapHolder.current = makeXForgeSnap('running')
  })

  it('outcome completed 但 XForge 仍处非法非终态 → fail closed 提交阶段 failed', async () => {
    await sendAgentMessage({ sessionId: 'sess-1', content: '实现登录' }, deps)

    expect(stageCommitter.commitXForgeStageTransition).toHaveBeenCalledWith(
      'run-xforge',
      expect.objectContaining({
        ok: true,
        from: 'implement',
        to: 'failed',
        reason: 'XForge Pipeline 未进入 waiting_user 或终态即退出'
      })
    )
    expect(coordinator.commitTerminal).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: 'completed' })
    )
  })

  it('outcome cancelled → 提交阶段 cancelled', async () => {
    stubAgentLoop.sendMessage.mockResolvedValue({ status: 'cancelled' })

    await sendAgentMessage({ sessionId: 'sess-1', content: '实现登录' }, deps)

    expect(stageCommitter.commitXForgeStageTransition).toHaveBeenCalledWith(
      'run-xforge',
      expect.objectContaining({ to: 'cancelled', reason: '用户取消 XForge 执行' })
    )
  })

  it('outcome failed → 阶段 failed（原始错误）并关闭 run', async () => {
    stubAgentLoop.sendMessage.mockResolvedValue({
      status: 'failed',
      error: new Error('pipeline 崩溃')
    })

    await sendAgentMessage({ sessionId: 'sess-1', content: '实现登录' }, deps)

    expect(stageCommitter.commitXForgeStageTransition).toHaveBeenCalledWith(
      'run-xforge',
      expect.objectContaining({ to: 'failed', reason: 'pipeline 崩溃' })
    )
    expect(coordinator.commitTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run-xforge', status: 'failed', reason: 'pipeline 崩溃' })
    )
  })

  it('XForge 已进入 waiting_user → 不提交任何通用终态覆盖', async () => {
    snapHolder.current = makeXForgeSnap('waiting_user', 'waiting_user')

    await sendAgentMessage({ sessionId: 'sess-1', content: '实现登录' }, deps)

    expect(stageCommitter.commitXForgeStageTransition).not.toHaveBeenCalled()
    expect(coordinator.commitTerminal).not.toHaveBeenCalled()
  })

  it('XForge 阶段已是终态但 run 仍在 running（outcome failed）→ 只关闭 run 不再动阶段', async () => {
    snapHolder.current = makeXForgeSnap('running', 'failed')
    stubAgentLoop.sendMessage.mockResolvedValue({
      status: 'failed',
      error: new Error('late failure')
    })

    await sendAgentMessage({ sessionId: 'sess-1', content: '实现登录' }, deps)

    expect(stageCommitter.commitXForgeStageTransition).not.toHaveBeenCalled()
    expect(coordinator.commitTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run-xforge', status: 'failed', reason: 'late failure' })
    )
  })
})

describe('sendMessage rejection 与记忆提炼门控', () => {
  it('sendMessage reject（装配错误）→ 异常收敛为 interrupted 并向上抛出', async () => {
    stubAgentLoop.sendMessage.mockRejectedValue(new Error('route 为 xforge 但未注入 xforgeRunner'))

    await expect(
      sendAgentMessage({ sessionId: 'sess-1', content: '你好' }, deps)
    ).rejects.toThrow(/未注入 xforgeRunner/)

    expect(coordinator.commitTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-agent',
        status: 'interrupted',
        reason: 'route 为 xforge 但未注入 xforgeRunner'
      })
    )
  })

  it('记忆提炼只在 completed 触发', async () => {
    await sendAgentMessage({ sessionId: 'sess-1', content: '你好' }, deps)
    expect(extractSpy).toHaveBeenCalledTimes(1)

    extractSpy.mockClear()
    stubAgentLoop.sendMessage.mockResolvedValue({
      status: 'failed',
      error: new Error('boom')
    })
    await sendAgentMessage({ sessionId: 'sess-1', content: '你好' }, deps)
    expect(extractSpy).not.toHaveBeenCalled()
  })
})
