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
  } as Record<string, unknown> | null,
  // 按 runId 分派的显式快照：接力预约与父 turn 必须看到各自的状态
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
const executionRegistry = vi.hoisted(() => ({
  register: vi.fn(),
  unregister: vi.fn()
}))
const extractSpy = vi.hoisted(() => vi.fn())

const registryHolder = vi.hoisted(() => ({ current: null as any }))

// 投递协调器是外部状态 Owner：这里只记录调用并给出受控返回值。
const deliveryCoordinator = vi.hoisted(() => ({
  createActiveTurnReceiver: vi.fn(() => ({ receive: vi.fn(async () => []) })),
  noteExecutionSettled: vi.fn(),
  admitIdleRelay: vi.fn(() => null as { relayRunId: string } | null),
  settleRelayReservation: vi.fn(),
  supersedeQueuedRelayReservations: vi.fn(),
  reconcileDeliveryOnStartup: vi.fn(() => [] as string[]),
  listSessionsAwaitingRelay: vi.fn(() => [] as string[])
}))

const stubAgentLoop = vi.hoisted(() => ({
  setRuntimeInputReceiver: vi.fn(),
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

vi.mock('../../../src/main/services/SkillServiceHost', () => ({
  ensureSkillRegistryForWorkspace: vi.fn(() => registryHolder.current)
}))

import {
  sendAgentMessage,
  configureIdleRelay,
  resumeIdleRelaysAfterStartup
} from '../../../src/main/agent/turn/AgentTurnService'
import {
  enqueueSteeringMessage,
  hasSteeringMessage,
  resetSteeringQueueForTests
} from '../../../src/main/agent/turn/SteeringQueue'

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
  snapHolder.byRunId.clear()
  sessionStore.load.mockReturnValue(makeSession())
  stubAgentLoop.sendMessage.mockResolvedValue({ status: 'completed' })
  deliveryCoordinator.admitIdleRelay.mockReturnValue(null)
  deliveryCoordinator.listSessionsAwaitingRelay.mockReturnValue([])
  resetSteeringQueueForTests()
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

describe('空闲接力在 turn 正常收敛后才接管', () => {
  const sessionId = 'sess-idle'
  const relayRunId = 'relay-idle'
  const trigger = {
    version: 1,
    requestId: relayRunId,
    receiveMessageId: `msg_relay_${relayRunId}`,
    originUserMessageId: 'user-origin',
    anchorMessageId: null,
    items: [{ notificationId: 'ntf_child', sourceRunId: 'run-child', content: '后台结果' }],
    createdAt: 1
  }

  /** 登记一个未执行的接力预约快照，并让接纳返回它。 */
  const admitRelay = (): void => {
    snapHolder.byRunId.set(relayRunId, {
      runId: relayRunId, kind: 'agent', status: 'queued',
      sessionId, workspaceId: '/tmp/ws', relayTrigger: trigger
    })
    deliveryCoordinator.admitIdleRelay.mockReturnValue({ relayRunId })
  }

  it('父 turn completed 时接纳并接管同一预约 run', async () => {
    admitRelay()
    configureIdleRelay(deps)
    snapHolder.current = {
      runId: 'run-agent', kind: 'agent', status: 'completed',
      sessionId: 'sess-1', workspaceId: '/tmp/ws'
    }

    await sendAgentMessage({ sessionId, content: '你好' }, deps)

    expect(deliveryCoordinator.admitIdleRelay).toHaveBeenCalledTimes(1)
    expect(deliveryCoordinator.admitIdleRelay).toHaveBeenCalledWith(sessionId)
    // 接管复用预约身份，不新开 run
    expect(coordinator.startRun).toHaveBeenCalledWith(expect.objectContaining({ runId: relayRunId }))
  })

  it.each(['failed', 'cancelled', 'interrupted'])('父 turn %s 后不自动接力', async status => {
    admitRelay()
    configureIdleRelay(deps)
    snapHolder.current = {
      runId: 'run-agent', kind: 'agent', status,
      sessionId: 'sess-1', workspaceId: '/tmp/ws'
    }

    await sendAgentMessage({ sessionId, content: '你好' }, deps)

    expect(deliveryCoordinator.admitIdleRelay).not.toHaveBeenCalled()
  })

  it('同会话排队的用户消息优先：当前 turn 不抢先接纳接力', async () => {
    admitRelay()
    configureIdleRelay(deps)
    snapHolder.current = {
      runId: 'run-agent', kind: 'agent', status: 'completed',
      sessionId: 'sess-1', workspaceId: '/tmp/ws'
    }
    enqueueSteeringMessage(sessionId, { sessionId, content: '排队消息' })

    await sendAgentMessage({ sessionId, content: '你好' }, deps)
    await vi.waitFor(() =>
      expect(coordinator.startRun).toHaveBeenCalledWith(expect.objectContaining({ runId: relayRunId }))
    )

    // 排队消息先出队执行：接纳发生在那之后，当前 turn 没有抢先接力
    expect(hasSteeringMessage(sessionId)).toBe(false)
    const sendOrders = stubAgentLoop.sendMessage.mock.invocationCallOrder
    expect(sendOrders.length).toBeGreaterThanOrEqual(2)
    expect(deliveryCoordinator.admitIdleRelay.mock.invocationCallOrder[0])
      .toBeGreaterThan(sendOrders[1])
    expect(deliveryCoordinator.admitIdleRelay.mock.calls[0]).toEqual([sessionId])
  })

  it('启动恢复对仍待接力的会话逐个触发接管', async () => {
    // 两个会话都登记了同一份未执行预约：接管按会话逐个发起，不遗漏也不重复
    snapHolder.byRunId.set(relayRunId, {
      runId: relayRunId, kind: 'agent', status: 'queued',
      sessionId, workspaceId: '/tmp/ws', relayTrigger: trigger
    })
    deliveryCoordinator.listSessionsAwaitingRelay.mockReturnValue([sessionId, 'sess-other'])
    deliveryCoordinator.admitIdleRelay.mockReturnValue({ relayRunId })
    configureIdleRelay(deps)

    resumeIdleRelaysAfterStartup()
    await vi.waitFor(() => expect(stubAgentLoop.sendMessage).toHaveBeenCalledTimes(1))
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(deliveryCoordinator.listSessionsAwaitingRelay).toHaveBeenCalledTimes(1)
    // 两个会话都被查询接纳，不遗漏
    expect(deliveryCoordinator.admitIdleRelay.mock.calls).toEqual([[sessionId], ['sess-other']])
    // 同一 relayRunId 的接管单飞：第二次触发 join 已有接管，不重复执行
    expect(coordinator.startRun.mock.calls.filter(call => call[0]?.runId === relayRunId)).toHaveLength(1)
    expect(stubAgentLoop.sendMessage).toHaveBeenCalledTimes(1)
  })
})
