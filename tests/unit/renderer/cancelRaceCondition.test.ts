import { makeRunSnapshot, publishRunSnapshot } from './runSnapshotFixture'
import { selectSessionIsRunning } from '../../../src/renderer/stores/useRunStore'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mockInvoke = vi.fn()
const mockOn = vi.fn()

beforeEach(() => {
  global.window = {
    ...global.window,
    api: {
      invoke: mockInvoke,
      on: mockOn,
      removeAllListeners: vi.fn()
    }
  } as unknown as Window & typeof globalThis
})

describe('cancel 由 RunCoordinator 确认终态', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    const { useChatStore, resetChatStoreForTests } = await import('../../../src/renderer/stores/useChatStore')
    const { resetAgentStoreForTests } = await import('../../../src/renderer/stores/useAgentStore')
    const { useRunStore } = await import('../../../src/renderer/stores/useRunStore')
    const { useWorkspaceStore } = await import('../../../src/renderer/stores/useWorkspaceStore')
    resetChatStoreForTests()
    resetAgentStoreForTests()
    useRunStore.getState().resetForTests()
    useWorkspaceStore.setState({ currentProjectPath: '/test/project' })
    useChatStore.setState({ currentSessionId: 's1' })
    useRunStore.getState().selectSession('s1')
    mockInvoke.mockImplementation(async (channel: string) => {
      if (channel === 'load-session') return { messages: useChatStore.getState().messages, hasMoreMessagesAbove: false }
      if (channel === 'get-message-diffs') return { diffs: [], reviews: {} }
      return undefined
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('点击取消后立即 cancelling，不在本地宣布 运行已结束', async () => {
    const { useChatStore } = await import('../../../src/renderer/stores/useChatStore')
    const { useAgentStore } = await import('../../../src/renderer/stores/useAgentStore')
    const { useRunStore } = await import('../../../src/renderer/stores/useRunStore')

    useChatStore.getState().handleMessageStart('msg_to_cancel')
    useChatStore.setState({ currentGeneratingMessageId: 'msg_to_cancel' })

    publishRunSnapshot(makeRunSnapshot({ sessionId: useChatStore.getState().currentSessionId!, messageId: useChatStore.getState().currentGeneratingMessageId! }))
    useRunStore.getState().selectSession(useChatStore.getState().currentSessionId)
    await useAgentStore.getState().cancelExecution()

    expect(mockInvoke).toHaveBeenCalledWith('cancel-execution', { runId: 'run_1' })
    expect(useRunStore.getState().cancelling).toBe(true)
    // Renderer 不能独立宣布后台 run 已结束
    expect(selectSessionIsRunning(useRunStore.getState(), useChatStore.getState().currentSessionId)).toBe(true)
  })

  it('snapshot 确认 terminal 后才结束运行', async () => {
    const { useChatStore } = await import('../../../src/renderer/stores/useChatStore')
    const { useAgentStore } = await import('../../../src/renderer/stores/useAgentStore')
    const { useRunStore } = await import('../../../src/renderer/stores/useRunStore')

    useChatStore.getState().handleMessageStart('msg_to_cancel')
    useChatStore.setState({ currentGeneratingMessageId: 'msg_to_cancel' })

    publishRunSnapshot(makeRunSnapshot({ sessionId: useChatStore.getState().currentSessionId!, messageId: useChatStore.getState().currentGeneratingMessageId! }))
    useRunStore.getState().selectSession(useChatStore.getState().currentSessionId)
    await useAgentStore.getState().cancelExecution()
    expect(useRunStore.getState().cancelling).toBe(true)

    useRunStore.getState().handleSnapshotEvent(
      {
        runId: 'run_1',
        kind: 'agent',
        workspaceId: '/ws',
        sessionId: 's1',
        messageId: 'msg_to_cancel',
        status: 'cancelled',
        sequence: 5,
        pendingInteractions: [],
        currentAttempt: null,
        progress: null,
        lastHeartbeatAt: Date.now(),
        createdAt: Date.now(),
        updatedAt: Date.now()
      },
      { sequence: 5, type: 'terminal', at: Date.now() }
    )

    await vi.waitFor(() => {
      expect(useRunStore.getState().cancelling).toBe(false)
      expect(selectSessionIsRunning(useRunStore.getState(), useChatStore.getState().currentSessionId)).toBe(false)
    })
  })

  it('其他会话的终态不确认取消，当前会话的终态才复位', async () => {
    const { useChatStore } = await import('../../../src/renderer/stores/useChatStore')
    const { useAgentStore } = await import('../../../src/renderer/stores/useAgentStore')
    const { useRunStore } = await import('../../../src/renderer/stores/useRunStore')

    useChatStore.getState().handleMessageStart('msg_session_cancel')
    useChatStore.setState({
      currentGeneratingMessageId: 'msg_session_cancel',
      currentSessionId: 's2'
    })

    publishRunSnapshot(makeRunSnapshot({ sessionId: useChatStore.getState().currentSessionId!, messageId: useChatStore.getState().currentGeneratingMessageId! }))
    useRunStore.getState().selectSession(useChatStore.getState().currentSessionId)
    await useAgentStore.getState().cancelExecution()
    expect(useRunStore.getState().cancelling).toBe(true)

    const terminal = {
      kind: 'agent',
      workspaceId: '/ws',
      messageId: 'msg_session_cancel',
      status: 'cancelled',
      pendingInteractions: [],
      currentAttempt: null,
      progress: null,
      lastHeartbeatAt: Date.now(),
      createdAt: Date.now(),
      updatedAt: Date.now()
    } as const

    useRunStore.getState().handleSnapshotEvent(
      { ...terminal, runId: 'run_other', sessionId: 's1', sequence: 5 },
      { sequence: 5, type: 'terminal', at: Date.now() }
    )
    // 事件投影是异步的，等一个宏任务再确认取消态未被其他会话打断
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(useRunStore.getState().cancelling).toBe(true)

    useRunStore.getState().handleSnapshotEvent(
      { ...terminal, runId: 'run_1', sessionId: 's2', sequence: 5 },
      { sequence: 5, type: 'terminal', at: Date.now() }
    )
    await vi.waitFor(() => {
      expect(useRunStore.getState().cancelling).toBe(false)
      expect(selectSessionIsRunning(useRunStore.getState(), useChatStore.getState().currentSessionId)).toBe(false)
    })
  })

  it('超 grace 显示 cancelGraceExceeded，可 forceTerminate', async () => {
    vi.useFakeTimers()
    const { useAgentStore } = await import('../../../src/renderer/stores/useAgentStore')
    const { useRunStore } = await import('../../../src/renderer/stores/useRunStore')
    const { useChatStore } = await import('../../../src/renderer/stores/useChatStore')

    useChatStore.setState({ currentGeneratingMessageId: 'msg_x' })
    publishRunSnapshot(makeRunSnapshot({ sessionId: useChatStore.getState().currentSessionId!, messageId: useChatStore.getState().currentGeneratingMessageId! }))
    useRunStore.getState().selectSession(useChatStore.getState().currentSessionId)
    await useAgentStore.getState().cancelExecution()

    vi.advanceTimersByTime(8_000)
    expect(useRunStore.getState().cancelGraceExceeded).toBe(true)

    mockInvoke.mockResolvedValue({
      ok: true,
      snapshot: {
        runId: 'run_1',
        kind: 'agent',
        workspaceId: '/ws',
        sessionId: 's1',
        messageId: 'msg_x',
        status: 'cancelled',
        sequence: 9,
        pendingInteractions: [],
        currentAttempt: null,
        progress: null,
        lastHeartbeatAt: Date.now(),
        createdAt: Date.now(),
        updatedAt: Date.now()
      }
    })
    await useRunStore.getState().forceTerminate()
    expect(useRunStore.getState().cancelling).toBe(false)
    expect(selectSessionIsRunning(useRunStore.getState(), useChatStore.getState().currentSessionId)).toBe(false)
  })

  it('没有可识别 run 时不发送无归属取消命令', async () => {
    const { useAgentStore } = await import('../../../src/renderer/stores/useAgentStore')
    const { useRunStore } = await import('../../../src/renderer/stores/useRunStore')
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await useAgentStore.getState().cancelExecution()
      expect(mockInvoke).not.toHaveBeenCalledWith('cancel-execution', expect.anything())
      expect(useRunStore.getState().cancelling).toBe(false)
      expect(error).toHaveBeenCalledWith('取消执行失败:', expect.objectContaining({ message: '无法取消：当前会话没有可识别的运行' }))
    } finally { error.mockRestore() }
  })

  it('显示消息 ID 尚未建立时仍按快照 runId 取消', async () => {
    const { useAgentStore } = await import('../../../src/renderer/stores/useAgentStore')
    const { useRunStore } = await import('../../../src/renderer/stores/useRunStore')
    publishRunSnapshot(makeRunSnapshot({ sessionId: 's1' }))
    await useAgentStore.getState().cancelExecution()
    expect(mockInvoke).toHaveBeenCalledWith('cancel-execution', { runId: 'run_1' })
    expect(useRunStore.getState().cancelling).toBe(true)
  })

  it('指定 parked runId 时精确传给 IPC，不依赖当前全局 active run', async () => {
    const { useAgentStore } = await import('../../../src/renderer/stores/useAgentStore')
    mockInvoke.mockResolvedValue({ runId: 'parked-run', status: 'cancelled' })

    await useAgentStore.getState().cancelExecution('parked-run')

    expect(mockInvoke).toHaveBeenCalledWith('cancel-execution', { runId: 'parked-run' })
  })

  it('A 会话取消中切到 B：A 的终态到达后取消仍收敛，取消态不污染 B 视图', async () => {
    const { useChatStore } = await import('../../../src/renderer/stores/useChatStore')
    const { useAgentStore } = await import('../../../src/renderer/stores/useAgentStore')
    const { useRunStore } = await import('../../../src/renderer/stores/useRunStore')

    const runASnap = makeRunSnapshot({
      runId: 'runA',
      kind: 'agent',
      workspaceId: '/ws',
      sessionId: 'sessA',
      messageId: 'msg_a',
      status: 'running',
      sequence: 1,
      pendingInteractions: [],
      currentAttempt: null,
      progress: null,
      lastHeartbeatAt: Date.now(),
      createdAt: Date.now(),
      updatedAt: Date.now()
    })
    useChatStore.setState({ currentSessionId: 'sessA' })
    useRunStore.setState({
      selectedSessionId: 'sessA',
      activeRunIdBySessionId: { sessA: 'runA' },
      snapshotsByRunId: { runA: runASnap }
    })

    mockInvoke.mockResolvedValue({ runId: 'runA', status: 'cancelling' })
    await useAgentStore.getState().cancelExecution()
    expect(useRunStore.getState().cancelling).toBe(true)
    expect(useRunStore.getState().cancellingSessionId).toBe('sessA')

    // 切到 B：取消归属校验后不呈现给 B 视图（与 ChatPanel 渲染条件同语义）
    useChatStore.setState({ currentSessionId: 'sessB' })
    const runState = useRunStore.getState()
    const appliesToB =
      runState.cancelling &&
      (runState.cancellingSessionId == null || runState.cancellingSessionId === 'sessB')
    expect(appliesToB).toBe(false)

    // A 的终态 snapshot 跨会话到达：取消正常收敛，不得残留全局 cancelling
    useRunStore.getState().handleSnapshotEvent(
      { ...runASnap, status: 'cancelled', sequence: 9 },
      { sequence: 9, type: 'terminal', at: Date.now() }
    )
    await vi.waitFor(() => {
      expect(useRunStore.getState().cancelling).toBe(false)
      expect(useRunStore.getState().forceTerminateRunId).toBeNull()
      expect(useRunStore.getState().cancellingSessionId).toBeNull()
    })
  })

  it('取消 ACK 保留权限请求，只有目标 run 终态快照清除请求', async () => {
    const { useAgentStore } = await import('../../../src/renderer/stores/useAgentStore')
    const { useRunStore } = await import('../../../src/renderer/stores/useRunStore')
    const snapA = makeRunSnapshot({
      runId: 'runA',
      kind: 'agent',
      workspaceId: '/ws',
      sessionId: 'sessA',
      messageId: 'msg_a',
      status: 'running',
      sequence: 1,
      pendingInteractions: [],
      currentAttempt: null,
      progress: null,
      lastHeartbeatAt: Date.now(),
      createdAt: Date.now(),
      updatedAt: Date.now()
    })
    useRunStore.setState({
      selectedSessionId: 'sessA',
      activeRunIdBySessionId: { sessA: 'runA' },
      snapshotsByRunId: { runA: snapA }
    })
    const { useChatStore } = await import('../../../src/renderer/stores/useChatStore')
    useChatStore.setState({ currentSessionId: 'sessA' })
    publishRunSnapshot({ ...snapA, status: 'waiting_user', sequence: 2, pendingInteractions: [{
      interactionId: 'perm_1', runId: 'runA', sessionId: 'sessA', messageId: 'msg_a',
      type: 'permission', status: 'pending', version: 1, createdAt: 1,
      payload: { requestId: 'perm_1', toolName: 'bash', args: { command: 'npm test' } }
    }] })
    await useRunStore.getState().refreshInteractionProjection()
    await useAgentStore.getState().cancelExecution()
    expect(useAgentStore.getState().pendingPermissionRequest?.requestId).toBe('perm_1')
    publishRunSnapshot({ ...snapA, status: 'cancelled', sequence: 3 })
    await useRunStore.getState().refreshInteractionProjection()
    expect(useAgentStore.getState().pendingPermissionRequest).toBeNull()
    expect(mockInvoke).toHaveBeenCalledWith('cancel-execution', { runId: 'runA' })
  })

  it('子代理后代会话的 pending 请求不是本次取消目标，保留等待响应', async () => {
    const { useAgentStore } = await import('../../../src/renderer/stores/useAgentStore')
    const { useRunStore } = await import('../../../src/renderer/stores/useRunStore')
    const snapA = makeRunSnapshot({
      runId: 'runA',
      kind: 'agent',
      workspaceId: '/ws',
      sessionId: 'sessA',
      messageId: 'msg_a',
      status: 'running',
      sequence: 1,
      pendingInteractions: [],
      currentAttempt: null,
      progress: null,
      lastHeartbeatAt: Date.now(),
      createdAt: Date.now(),
      updatedAt: Date.now()
    })
    useRunStore.setState({
      selectedSessionId: 'sessA',
      activeRunIdBySessionId: { sessA: 'runA' },
      snapshotsByRunId: { runA: snapA }
    })
    // 子代理会话投影到父会话权限条的请求：sessionId 指向后代会话
    useAgentStore.getState().handlePermissionRequest({
      messageId: 'msg_child',
      requestId: 'perm_child',
      toolName: 'bash',
      args: { command: 'npm test' },
      riskLevel: 'low',
      reason: '子任务需要确认',
      sessionId: 'sess_child'
    })

    mockInvoke.mockResolvedValue({ runId: 'runA', status: 'cancelling' })
    await useAgentStore.getState().cancelExecution()

    // 子 run 不会因父会话取消而终止，误清会让用户失去这次响应机会
    expect(useAgentStore.getState().pendingPermissionRequest?.requestId).toBe('perm_child')
    expect(useAgentStore.getState().pendingPermissionRequest?.sessionId).toBe('sess_child')
  })
})
