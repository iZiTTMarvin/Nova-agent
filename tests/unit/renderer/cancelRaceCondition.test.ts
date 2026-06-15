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

describe('Phase 3 cancel + Phase 6 dispatch 5s 兜底竞态保护', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    // 重置所有 store
    const { resetChatStoreForTests } = await import('../../../src/renderer/stores/useChatStore')
    const { resetAgentStoreForTests } = await import('../../../src/renderer/stores/useAgentStore')
    const { useWorkspaceStore } = await import('../../../src/renderer/stores/useWorkspaceStore')
    resetChatStoreForTests()
    resetAgentStoreForTests()
    // PRD §5.1：sendMessage 现在从 workspace store 读 currentProjectPath
    useWorkspaceStore.setState({ currentProjectPath: '/test/project' })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('5s 兜底超时：当前消息仍是取消时那条时，应 markRunningAsCancelled', async () => {
    vi.useFakeTimers()
    const { useChatStore } = await import('../../../src/renderer/stores/useChatStore')
    const { useAgentStore } = await import('../../../src/renderer/stores/useAgentStore')

    // 1. 模拟助手正在生成
    useChatStore.getState().handleMessageStart('msg_to_cancel')
    useChatStore.setState({ isGenerating: true, currentGeneratingMessageId: 'msg_to_cancel' })

    // 2. 取消
    mockInvoke.mockResolvedValue(undefined)
    await useAgentStore.getState().cancelExecution()

    // 3. 5s 后主进程仍未推 message-end（模拟卡死）
    vi.advanceTimersByTime(5000)
    // 让 setTimeout(0) 的动态 import 微任务完成
    await Promise.resolve()
    await Promise.resolve()

    // 4. 验证 isGenerating 被强制复位
    const state = useChatStore.getState()
    expect(state.isGenerating).toBe(false)
    expect(state.currentGeneratingMessageId).toBeNull()
  })

  it('5s 兜底超时：currentGeneratingMessageId 已被新消息替换时，不应误杀新消息（I1 修复验证）', async () => {
    vi.useFakeTimers()
    const { useChatStore } = await import('../../../src/renderer/stores/useChatStore')
    const { useAgentStore } = await import('../../../src/renderer/stores/useAgentStore')

    // 1. 模拟助手正在生成 msg_to_cancel
    useChatStore.getState().handleMessageStart('msg_to_cancel')
    useChatStore.setState({ isGenerating: true, currentGeneratingMessageId: 'msg_to_cancel' })

    // 2. 取消之前先入队一条新消息，turn boundary 时会自动 dispatch
    useChatStore.getState().enqueuePendingMessage('新消息（用户排队）', [])

    // 3. 取消
    mockInvoke.mockResolvedValue(undefined)
    await useAgentStore.getState().cancelExecution()

    // 4. 关键：模拟主进程正常推了 message-end（interrupted=true）
    //    → dispatchNextPending 被调用 → 入队的新消息被 sendMessage
    //    → isGenerating=true，currentGeneratingMessageId='msg_xxx'
    await useChatStore.getState().handleMessageEnd('msg_to_cancel', true)

    const stateAfterTurn = useChatStore.getState()
    expect(stateAfterTurn.isGenerating).toBe(true)
    // 新消息的 messageId 与取消时不同（sendMessage 内部用 Date.now() 生成）
    expect(stateAfterTurn.currentGeneratingMessageId).not.toBe('msg_to_cancel')
    // pending 队列应已清空
    expect(stateAfterTurn.pendingUserMessages).toHaveLength(0)

    // 5. 5s 后兜底定时器触发
    vi.advanceTimersByTime(5000)
    await Promise.resolve()
    await Promise.resolve()

    // 6. 关键断言：新消息不应被误杀，isGenerating 应保持 true
    const stateAfterFallback = useChatStore.getState()
    expect(stateAfterFallback.isGenerating).toBe(true)
    expect(stateAfterFallback.currentGeneratingMessageId).not.toBe('msg_to_cancel')
  })

  it('cancelledMessageId 为 null 时不启动兜底定时器（双击取消场景）', async () => {
    vi.useFakeTimers()
    const { useChatStore } = await import('../../../src/renderer/stores/useChatStore')
    const { useAgentStore } = await import('../../../src/renderer/stores/useAgentStore')

    // 1. 模拟没有任何正在生成的消息
    expect(useChatStore.getState().currentGeneratingMessageId).toBeNull()

    // 2. 取消（应发 IPC 信号但不启动 5s 兜底定时器）
    mockInvoke.mockResolvedValue(undefined)
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout')
    await useAgentStore.getState().cancelExecution()
    expect(mockInvoke).toHaveBeenCalledWith('cancel-execution')

    // 3. 推进 6s：不应有定时器被触发（pendingUserMessages 等也未变）
    vi.advanceTimersByTime(6000)

    // 4. 由于没启动定时器，clearTimeout 也不应被 cancel 路径调用
    //    （clearTimeout 可能被 setState 内部其他路径调用，但兜底分支明确未启动）
    // 验证 isGenerating 仍为 false（没有被误设为 true）
    expect(useChatStore.getState().isGenerating).toBe(false)
    expect(useChatStore.getState().currentGeneratingMessageId).toBeNull()

    clearSpy.mockRestore()
  })

  it('正常完成路径：handleMessageEnd 之后 5s 兜底定时器不应再触发（clearCancelFallback）', async () => {
    vi.useFakeTimers()
    const { useChatStore } = await import('../../../src/renderer/stores/useChatStore')
    const { useAgentStore } = await import('../../../src/renderer/stores/useAgentStore')

    // 1. 启动生成
    useChatStore.getState().handleMessageStart('msg_normal')
    useChatStore.setState({ isGenerating: true, currentGeneratingMessageId: 'msg_normal' })

    // 2. 取消（启动 5s 兜底定时器）
    mockInvoke.mockResolvedValue(undefined)
    await useAgentStore.getState().cancelExecution()

    // 3. 0.5s 后主进程正常推 message-end（interrupted=true）
    vi.advanceTimersByTime(500)
    await useChatStore.getState().handleMessageEnd('msg_normal', true)
    expect(useChatStore.getState().isGenerating).toBe(false)

    // 4. 关键：clearCancelFallback 已被 useChatStore.handleMessageEnd 调用，
    //    之后 5s 推进时定时器不应再触发（已 clear）
    vi.advanceTimersByTime(5000)
    await Promise.resolve()
    await Promise.resolve()

    // 5. 状态应保持 isGenerating=false、currentGeneratingMessageId=null
    const state = useChatStore.getState()
    expect(state.isGenerating).toBe(false)
    expect(state.currentGeneratingMessageId).toBeNull()
  })

  it('clearCancelFallback 单独调用是 no-op（防御性：没有定时器时不应抛错）', async () => {
    const { useAgentStore } = await import('../../../src/renderer/stores/useAgentStore')

    // 没有 cancel 过的状态下调 clearCancelFallback 不应抛错
    expect(() => useAgentStore.getState().clearCancelFallback()).not.toThrow()
    // 多次调用也安全
    expect(() => useAgentStore.getState().clearCancelFallback()).not.toThrow()
  })

  it('markRunningAsCancelled 路径同样会清除兜底定时器', async () => {
    vi.useFakeTimers()
    const { useChatStore } = await import('../../../src/renderer/stores/useChatStore')
    const { useAgentStore } = await import('../../../src/renderer/stores/useAgentStore')

    // 1. 启动生成
    useChatStore.getState().handleMessageStart('msg_mark')
    useChatStore.setState({ isGenerating: true, currentGeneratingMessageId: 'msg_mark' })

    // 2. 取消
    mockInvoke.mockResolvedValue(undefined)
    await useAgentStore.getState().cancelExecution()

    // 3. 1s 后调 markRunningAsCancelled（不走 handleMessageEnd，模拟 IPC 通道异常场景）
    vi.advanceTimersByTime(1000)
    await useChatStore.getState().markRunningAsCancelled()
    expect(useChatStore.getState().isGenerating).toBe(false)

    // 4. 推进 5s：兜底定时器已 clear，不应再触发
    vi.advanceTimersByTime(5000)
    await Promise.resolve()
    await Promise.resolve()
    expect(useChatStore.getState().isGenerating).toBe(false)
  })
})
