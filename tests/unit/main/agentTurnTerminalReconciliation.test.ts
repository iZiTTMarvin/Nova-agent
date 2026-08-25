/**
 * AgentTurnService 终态对账行为级测试。
 * 真实执行 sendAgentMessage，用 stub AgentLoop 返回结构化 outcome，
 * 证明 durable 终态由 outcome 驱动提交，且 cancelling / 已终态状态不被覆盖。
 */
import { beforeEach, describe, it, expect, vi } from 'vitest'

// ---- hoisted mocks：服务宿主与运行时装配 ----
const snapHolder = vi.hoisted(() => ({
  current: {
    runId: 'run-agent', kind: 'agent', status: 'running',
    sessionId: 'sess-1', workspaceId: '/tmp/ws'
  } as Record<string, unknown> | null
}))
const coordinator = vi.hoisted(() => ({
  listActiveRuns: vi.fn(() => [] as any[]),
  getSnapshotForSession: vi.fn(() => null),
  getSnapshot: vi.fn(() => snapHolder.current),
  startRun: vi.fn((params: any) => ({
    runId: 'run-agent', kind: params.kind, status: 'queued',
    sessionId: params.sessionId, workspaceId: params.workspaceId
  })),
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
const extractSpy = vi.hoisted(() => vi.fn())

const registryHolder = vi.hoisted(() => ({ current: null as any }))

const stubAgentLoop = vi.hoisted(() => ({
  setRunRef: vi.fn(),
  setExecutionIdentity: vi.fn(),
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
    permissionMode: 'auto',
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
    resolveToDataUrl: vi.fn((_store: any, url: string) => url),
    prepareAgentRuntime: vi.fn(() => ({
      agentLoop: stubAgentLoop,
      eventBus: { on: vi.fn() },
      modelPool: {},
      runRefs: { runId: '', resourceOwnerRunId: '', executionGeneration: 0 },
      frozenPrompt: 'system',
      skillRegistry: registryHolder.current
    }))
  }
})

import { sendAgentMessage } from '../../../src/main/agent/turn/AgentTurnService'

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
  snapHolder.current = {
    runId: 'run-agent', kind: 'agent', status: 'running',
    sessionId: 'sess-1', workspaceId: '/tmp/ws'
  }
  registryHolder.current = null
  coordinator.listActiveRuns.mockReturnValue([])
  coordinator.getSnapshotForSession.mockReturnValue(null)
  sessionStore.load.mockReturnValue(makeSession())
  stubAgentLoop.sendMessage.mockResolvedValue({ status: 'completed' })
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
    snapHolder.current = {
      runId: 'run-agent', kind: 'agent', status: 'cancelling',
      sessionId: 'sess-1', workspaceId: '/tmp/ws'
    }

    await sendAgentMessage({ sessionId: 'sess-1', content: '你好' }, deps)

    expect(coordinator.commitTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run-agent', status: 'cancelled' })
    )
  })

  it('snapshot 已是硬终态时不再提交（不覆盖既有终态）', async () => {
    snapHolder.current = {
      runId: 'run-agent', kind: 'agent', status: 'completed',
      sessionId: 'sess-1', workspaceId: '/tmp/ws'
    }

    await sendAgentMessage({ sessionId: 'sess-1', content: '你好' }, deps)

    expect(coordinator.commitTerminal).not.toHaveBeenCalled()
  })
})

describe('sendMessage rejection 与记忆提炼门控', () => {
  it('sendMessage reject（装配错误）→ 异常收敛为 interrupted 并向上抛出', async () => {
    stubAgentLoop.sendMessage.mockRejectedValue(new Error('AgentLoop 装配失败'))

    await expect(
      sendAgentMessage({ sessionId: 'sess-1', content: '你好' }, deps)
    ).rejects.toThrow(/AgentLoop 装配失败/)

    expect(coordinator.commitTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-agent',
        status: 'interrupted',
        reason: 'AgentLoop 装配失败'
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
