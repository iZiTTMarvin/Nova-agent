/**
 * idle loop 接替：新 turn 一开始就把上一轮托管的 loop 销毁。
 *
 * turn 结束后 AgentLoop 不销毁，而是交给 idleLoopsBySession 托管 266 秒的空闲压缩
 * 计时器。若旧 loop 一直活到新 turn 的 finally 才被接替，新一轮跑得比计时器剩余
 * 时间长时，旧 loop 会在新 turn 执行期间提交压缩——白白多花两次摘要请求，极端
 * 情况下还会抢跑压缩版本号，让之后的所有压缩被拒。
 *
 * 这里断言的是顺序：旧 loop 的 dispose 必须发生在新一轮 sendMessage 之前，
 * 且上一轮结束时它还没被销毁（托管语义本身不能被破坏）。
 */
import { beforeEach, describe, it, expect, vi } from 'vitest'

const snapHolder = vi.hoisted(() => ({
  current: {
    runId: 'run-agent', kind: 'agent', status: 'completed',
    sessionId: 'sess-1', workspaceId: '/tmp/ws'
  } as Record<string, unknown> | null,
  byRunId: new Map<string, Record<string, unknown>>()
}))
const coordinator = vi.hoisted(() => ({
  listActiveRuns: vi.fn(() => [] as any[]),
  listSnapshotsForSession: vi.fn(() => [] as any[]),
  getSnapshotForSession: vi.fn(() => null),
  getSnapshot: vi.fn((runId?: string) =>
    (runId ? snapHolder.byRunId.get(runId) : undefined) ?? snapHolder.current),
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
  batch: vi.fn((_runId: string, fn: () => unknown) => fn()),
  getStallLiveness: vi.fn(() => null),
  inbox: { enqueue: vi.fn(() => ({ interactionId: 'i', version: 1 })), cancelAllForRun: vi.fn() },
  onTerminalHook: vi.fn()
}))
const executionRegistry = vi.hoisted(() => ({ register: vi.fn(), unregister: vi.fn() }))

const deliveryCoordinator = vi.hoisted(() => ({
  createActiveTurnReceiver: vi.fn(() => ({ receive: vi.fn(async () => []) })),
  noteExecutionSettled: vi.fn(),
  admitIdleRelay: vi.fn(() => null as { relayRunId: string } | null),
  settleRelayReservation: vi.fn(),
  supersedeQueuedRelayReservations: vi.fn(),
  reconcileDeliveryOnStartup: vi.fn(() => [] as string[]),
  listSessionsAwaitingRelay: vi.fn(() => [] as string[])
}))

/** 每个 turn 一个独立的 stub loop，记录它在时间线上的动作 */
const loopHolder = vi.hoisted(() => {
  const timeline: string[] = []
  const loops: Array<{ name: string; dispose: ReturnType<typeof vi.fn> }> = []
  let created = 0
  const reset = () => {
    timeline.length = 0
    loops.length = 0
    created = 0
  }
  const create = () => {
    created += 1
    const name = `loop${created}`
    const dispose = vi.fn(() => {
      timeline.push(`dispose:${name}`)
    })
    const loop = {
      name,
      dispose,
      setRuntimeInputReceiver: vi.fn(),
      setRunRef: vi.fn(),
      setExecutionIdentity: vi.fn(),
      setExecutionFence: vi.fn(),
      cancel: vi.fn(),
      getHookManager: vi.fn(() => ({ trigger: vi.fn() })),
      sendMessage: vi.fn(async () => {
        timeline.push(`send:${name}`)
        return { status: 'completed' }
      })
    }
    loops.push(loop)
    return loop
  }
  return { timeline, loops, create, reset }
})

const registryHolder = vi.hoisted(() => ({ current: null as any }))

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/nova-test-userdata') },
  BrowserWindow: class BrowserWindow {}
}))
vi.mock('../../../src/main/services/RunCoordinatorHost', () => ({
  getRunCoordinator: () => coordinator,
  getRunExecutionRegistry: () => executionRegistry
}))
vi.mock('../../../src/main/services/SubagentDeliveryCoordinatorHost', () => ({
  getSubagentDeliveryCoordinator: () => deliveryCoordinator,
  setIdleRelayCallback: vi.fn()
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
vi.mock('../../../src/main/services/MemoryExtractHost', () => ({
  onMemoryExtractTurnStarted: vi.fn(),
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
    permissionMode: 'auto',
    memoryEnabled: false,
    maxToolRounds: null
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
      agentLoop: loopHolder.create(),
      eventBus: { on: vi.fn() },
      modelPool: {},
      runRefs: { runId: '', resourceOwnerRunId: '', executionGeneration: 0 },
      frozenPrompt: 'system',
      skillRegistry: registryHolder.current
    }))
  }
})
vi.mock('../../../src/main/services/SkillServiceHost', () => ({
  ensureSkillRegistryForWorkspace: vi.fn(() => registryHolder.current)
}))

const sessionStore = {
  isDraft: () => false,
  load: vi.fn(() => ({
    id: 'sess-1',
    mode: 'default',
    workspaceRoot: '/tmp/ws',
    messages: [],
    schemaVersion: 2,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    currentLeafId: null,
    frozenSystemPrompt: 'system'
  })),
  save: vi.fn(),
  getSessionsDir: vi.fn(() => '/tmp/sessions'),
  ensureCacheRoutingKey: vi.fn(() => null),
  appendMessageFast: vi.fn(() => ({ ok: true })),
  updateTitle: vi.fn(() => false),
  addGrantedSkillRoot: vi.fn(),
  loadContextSnapshot: vi.fn(() => null)
}
vi.mock('../../../src/main/services/SessionStoreHost', () => ({
  getSessionStore: () => sessionStore
}))

import {
  sendAgentMessage,
  disposeIdleLoopForSession
} from '../../../src/main/agent/turn/AgentTurnService'
import { resetSteeringQueueForTests } from '../../../src/main/agent/turn/SteeringQueue'

const deps = {
  getMainWindow: () => null,
  getModelClient: () => ({} as any),
  getImageStore: () => ({ read: vi.fn() } as any)
}

beforeEach(() => {
  // 先释放上一用例托管的 loop，再清时间线，避免它的 dispose 混进本用例
  disposeIdleLoopForSession('sess-1')
  vi.clearAllMocks()
  loopHolder.reset()
  snapHolder.current = {
    runId: 'run-agent', kind: 'agent', status: 'completed',
    sessionId: 'sess-1', workspaceId: '/tmp/ws'
  }
  snapHolder.byRunId.clear()
  coordinator.listActiveRuns.mockReturnValue([])
  coordinator.getSnapshotForSession.mockReturnValue(null)
  deliveryCoordinator.admitIdleRelay.mockReturnValue(null)
  deliveryCoordinator.listSessionsAwaitingRelay.mockReturnValue([])
  resetSteeringQueueForTests()
})

describe('idle loop 接替', () => {
  it('第 N 轮结束后 loop 仍被托管（空闲压缩窗口保留）', async () => {
    await sendAgentMessage({ sessionId: 'sess-1', content: '第一轮' }, deps)

    expect(loopHolder.loops).toHaveLength(1)
    expect(loopHolder.loops[0].dispose).not.toHaveBeenCalled()
    expect(loopHolder.timeline).toEqual(['send:loop1'])
  })

  it('第 N+1 轮开始前先销毁上一轮的 idle loop', async () => {
    await sendAgentMessage({ sessionId: 'sess-1', content: '第一轮' }, deps)
    await sendAgentMessage({ sessionId: 'sess-1', content: '第二轮' }, deps)

    // 顺序即契约：旧 loop 必须死在新一轮模型调用之前
    expect(loopHolder.timeline).toEqual(['send:loop1', 'dispose:loop1', 'send:loop2'])
    expect(loopHolder.loops[0].dispose).toHaveBeenCalledTimes(1)
    // 第 N+1 轮的 loop 仍是托管态，空闲压缩窗口没有被一起关掉
    expect(loopHolder.loops[1].dispose).not.toHaveBeenCalled()
  })

  it('手动释放时销毁的是当前托管的那一轮 loop', async () => {
    await sendAgentMessage({ sessionId: 'sess-1', content: '第一轮' }, deps)
    await sendAgentMessage({ sessionId: 'sess-1', content: '第二轮' }, deps)

    disposeIdleLoopForSession('sess-1')

    expect(loopHolder.loops[1].dispose).toHaveBeenCalledTimes(1)
    expect(loopHolder.loops[0].dispose).toHaveBeenCalledTimes(1)
  })
})
