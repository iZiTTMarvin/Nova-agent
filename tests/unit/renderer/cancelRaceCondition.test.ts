/**
 * T2-4：取消由 RunCoordinator 确认终态
 *
 * 旧行为：5s 本地兜底强制复位 isGenerating（会造成「界面说停了，后台还在跑」）。
 * 新行为：立即 cancelling；等 run:snapshot 终态或 force-terminate 后才 idle。
 */
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

describe('T2-4 cancel 由 RunCoordinator 确认终态', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    const { resetChatStoreForTests } = await import('../../../src/renderer/stores/useChatStore')
    const { resetAgentStoreForTests } = await import('../../../src/renderer/stores/useAgentStore')
    const { useRunStore } = await import('../../../src/renderer/stores/useRunStore')
    const { useWorkspaceStore } = await import('../../../src/renderer/stores/useWorkspaceStore')
    resetChatStoreForTests()
    resetAgentStoreForTests()
    useRunStore.getState().resetForTests()
    useWorkspaceStore.setState({ currentProjectPath: '/test/project' })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('点击取消后立即 cancelling，不在本地宣布 isGenerating=false', async () => {
    const { useChatStore } = await import('../../../src/renderer/stores/useChatStore')
    const { useAgentStore } = await import('../../../src/renderer/stores/useAgentStore')
    const { useRunStore } = await import('../../../src/renderer/stores/useRunStore')

    useChatStore.getState().handleMessageStart('msg_to_cancel')
    useChatStore.setState({ isGenerating: true, currentGeneratingMessageId: 'msg_to_cancel' })

    mockInvoke.mockResolvedValue({ runId: 'run_1', status: 'cancelling' })
    await useAgentStore.getState().cancelExecution()

    expect(mockInvoke).toHaveBeenCalledWith('cancel-execution')
    expect(useRunStore.getState().cancelling).toBe(true)
    // Renderer 不能独立宣布后台 run 已结束
    expect(useChatStore.getState().isGenerating).toBe(true)
  })

  it('snapshot 确认 terminal 后才复位 isGenerating', async () => {
    const { useChatStore } = await import('../../../src/renderer/stores/useChatStore')
    const { useAgentStore } = await import('../../../src/renderer/stores/useAgentStore')
    const { useRunStore } = await import('../../../src/renderer/stores/useRunStore')

    useChatStore.getState().handleMessageStart('msg_to_cancel')
    useChatStore.setState({ isGenerating: true, currentGeneratingMessageId: 'msg_to_cancel' })

    mockInvoke.mockResolvedValue({ runId: 'run_1', status: 'cancelling' })
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
      expect(useChatStore.getState().isGenerating).toBe(false)
    })
  })

  it('超 grace 显示 cancelGraceExceeded，可 forceTerminate', async () => {
    vi.useFakeTimers()
    const { useAgentStore } = await import('../../../src/renderer/stores/useAgentStore')
    const { useRunStore } = await import('../../../src/renderer/stores/useRunStore')
    const { useChatStore } = await import('../../../src/renderer/stores/useChatStore')

    useChatStore.setState({ isGenerating: true, currentGeneratingMessageId: 'msg_x' })
    mockInvoke.mockResolvedValue({ runId: 'run_1', status: 'cancelling' })
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
    expect(useChatStore.getState().isGenerating).toBe(false)
  })

  it('clearCancelFallback 单独调用是 no-op（兼容旧调用方）', async () => {
    const { useAgentStore } = await import('../../../src/renderer/stores/useAgentStore')
    expect(() => useAgentStore.getState().clearCancelFallback()).not.toThrow()
    expect(() => useAgentStore.getState().clearCancelFallback()).not.toThrow()
  })

  it('cancelledMessageId 为 null 时仍发 IPC，进入 cancelling', async () => {
    const { useChatStore } = await import('../../../src/renderer/stores/useChatStore')
    const { useAgentStore } = await import('../../../src/renderer/stores/useAgentStore')
    const { useRunStore } = await import('../../../src/renderer/stores/useRunStore')

    expect(useChatStore.getState().currentGeneratingMessageId).toBeNull()
    mockInvoke.mockResolvedValue({ runId: null, status: 'idle' })
    await useAgentStore.getState().cancelExecution()
    expect(mockInvoke).toHaveBeenCalledWith('cancel-execution')
    expect(useRunStore.getState().cancelling).toBe(true)
  })

  it('指定 parked XForge runId 时精确传给 IPC，不依赖当前全局 active run', async () => {
    const { useAgentStore } = await import('../../../src/renderer/stores/useAgentStore')
    mockInvoke.mockResolvedValue({ runId: 'parked-xforge', status: 'cancelled' })

    await useAgentStore.getState().cancelExecution('parked-xforge')

    expect(mockInvoke).toHaveBeenCalledWith('cancel-execution', { runId: 'parked-xforge' })
  })
})
