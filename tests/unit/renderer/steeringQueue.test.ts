import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useChatStore, resetChatStoreForTests } from '../../../src/renderer/stores/useChatStore'
import { useSettingsStore } from '../../../src/renderer/stores/useSettingsStore'

const mockInvoke = vi.fn()
const mockOn = vi.fn()

global.window = {
  ...global.window,
  api: {
    invoke: mockInvoke,
    on: mockOn,
    removeAllListeners: vi.fn()
  }
} as unknown as Window & typeof globalThis

describe('Steering Queue（Phase 6）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetChatStoreForTests()
    // 提供一个 currentProject 让 sendMessage 真的尝试发 IPC
    useSettingsStore.setState({ currentProject: '/test/project' })
  })

  it('enqueuePendingMessage 应把消息追加到队列', () => {
    useChatStore.getState().enqueuePendingMessage('问题 1', [])
    useChatStore.getState().enqueuePendingMessage('问题 2', [])

    const queue = useChatStore.getState().pendingUserMessages
    expect(queue).toHaveLength(2)
    expect(queue[0].text).toBe('问题 1')
    expect(queue[1].text).toBe('问题 2')
  })

  it('removePendingMessage 应按索引移除', () => {
    useChatStore.getState().enqueuePendingMessage('问题 1', [])
    useChatStore.getState().enqueuePendingMessage('问题 2', [])
    useChatStore.getState().enqueuePendingMessage('问题 3', [])

    useChatStore.getState().removePendingMessage(1)

    const queue = useChatStore.getState().pendingUserMessages
    expect(queue).toHaveLength(2)
    expect(queue[0].text).toBe('问题 1')
    expect(queue[1].text).toBe('问题 3')
  })

  it('clearPendingMessages 应清空队列', () => {
    useChatStore.getState().enqueuePendingMessage('问题 1', [])
    useChatStore.getState().clearPendingMessages()

    expect(useChatStore.getState().pendingUserMessages).toEqual([])
  })

  it('turn boundary: handleMessageEnd 后若有挂起消息应自动 dispatch 第一条', async () => {
    // 1. 先模拟一次正在进行的助手消息
    useChatStore.getState().handleMessageStart('msg_running')
    useChatStore.getState().handleTextDelta('msg_running', '正在思考')

    // 2. 用户在生成过程中输入并入队
    useChatStore.getState().enqueuePendingMessage('后续问题', [])
    expect(useChatStore.getState().pendingUserMessages).toHaveLength(1)

    // 3. 主进程推 message-end（正常完成）
    mockInvoke.mockResolvedValue(undefined)
    await useChatStore.getState().handleMessageEnd('msg_running')

    // 4. 队列首条应被 dispatch 触发 sendMessage
    // sendMessage 会追加用户消息 + 调用 IPC
    const state = useChatStore.getState()
    expect(state.pendingUserMessages).toHaveLength(0)
    expect(state.isGenerating).toBe(true)
    expect(mockInvoke).toHaveBeenCalledWith('send-message', expect.objectContaining({
      content: '后续问题'
    }))
  })

  it('turn boundary: cancel (interrupted message-end) 后也应 dispatch 挂起消息', async () => {
    // 1. 模拟助手正在运行
    useChatStore.getState().handleMessageStart('msg_cancel')
    useChatStore.getState().enqueuePendingMessage('cancel 后继续', [])
    expect(useChatStore.getState().pendingUserMessages).toHaveLength(1)

    // 2. cancel 后的 message-end（interrupted=true）
    mockInvoke.mockResolvedValue(undefined)
    await useChatStore.getState().handleMessageEnd('msg_cancel', true)

    // 3. 队列首条应被 dispatch
    const state = useChatStore.getState()
    expect(state.pendingUserMessages).toHaveLength(0)
    expect(state.isGenerating).toBe(true)
    expect(state.messages[state.messages.length - 1].id).toContain('user') // 追加了用户消息
  })

  it('挂起消息按 FIFO 顺序 dispatch', async () => {
    useChatStore.getState().handleMessageStart('msg_main')
    useChatStore.getState().enqueuePendingMessage('Q1', [])
    useChatStore.getState().enqueuePendingMessage('Q2', [])

    mockInvoke.mockResolvedValue(undefined)
    await useChatStore.getState().handleMessageEnd('msg_main')

    // 第一次 dispatch 把 Q1 发出，会创建新的 user 消息 + 设置 isGenerating
    // 此时不会再有第二次 dispatch（因为 sendMessage 自身 set 了 isGenerating=true）
    const state = useChatStore.getState()
    expect(state.isGenerating).toBe(true)
    expect(state.pendingUserMessages).toHaveLength(1) // Q2 还在排队
    expect(state.pendingUserMessages[0].text).toBe('Q2')
  })

  it('队列超过上限时应丢弃最早的项', () => {
    // 默认上限是 20
    for (let i = 0; i < 25; i++) {
      useChatStore.getState().enqueuePendingMessage(`msg-${i}`, [])
    }

    const queue = useChatStore.getState().pendingUserMessages
    expect(queue.length).toBe(20)
    // 最早 5 条（msg-0..msg-4）被丢弃
    expect(queue[0].text).toBe('msg-5')
    expect(queue[19].text).toBe('msg-24')
  })
})
