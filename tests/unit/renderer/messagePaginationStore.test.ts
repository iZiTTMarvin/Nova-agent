import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useChatStore, resetChatStoreForTests } from '../../../src/renderer/stores/useChatStore'
import { SESSION_HISTORY_PAGE_SIZE } from '../../../src/shared/session/messagePagination'

const mockInvoke = vi.fn()

describe('useChatStore 消息分页', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetChatStoreForTests()
    global.window = {
      ...global.window,
      api: { invoke: mockInvoke, on: vi.fn(() => () => {}), removeAllListeners: vi.fn() }
    } as unknown as Window & typeof globalThis
  })

  it('loadOlderMessages prepend 顺序正确并更新游标', async () => {
    useChatStore.setState({
      currentSessionId: 'sess_1',
      messages: [
        { id: 'msg_20', sessionId: 'sess_1', role: 'user', content: 'b', timestamp: 2, _revision: 0 },
        { id: 'msg_21', sessionId: 'sess_1', role: 'assistant', content: 'c', timestamp: 3, _revision: 0 }
      ],
      messageIndexById: { msg_20: 0, msg_21: 1 },
      hasMoreMessagesAbove: true,
      oldestLoadedMessageId: 'msg_20',
      isLoadingOlderMessages: false
    })

    mockInvoke.mockResolvedValue({
      messages: [
        { id: 'msg_18', sessionId: 'sess_1', role: 'user', content: 'a1', timestamp: 0 },
        { id: 'msg_19', sessionId: 'sess_1', role: 'assistant', content: 'a2', timestamp: 1 }
      ],
      hasMore: true
    })

    await useChatStore.getState().loadOlderMessages()

    const state = useChatStore.getState()
    expect(state.messages.map(m => m.id)).toEqual(['msg_18', 'msg_19', 'msg_20', 'msg_21'])
    expect(state.oldestLoadedMessageId).toBe('msg_18')
    expect(state.hasMoreMessagesAbove).toBe(true)
    expect(state.suspendHeadTrim).toBe(true)
    expect(state.isLoadingOlderMessages).toBe(false)
    expect(mockInvoke).toHaveBeenCalledWith('load-session-messages', {
      sessionId: 'sess_1',
      beforeId: 'msg_20',
      limit: SESSION_HISTORY_PAGE_SIZE
    })
  })

  it('补载进行中防重入', async () => {
    useChatStore.setState({
      currentSessionId: 'sess_1',
      messages: [{ id: 'msg_1', sessionId: 'sess_1', role: 'user', content: 'x', timestamp: 0, _revision: 0 }],
      hasMoreMessagesAbove: true,
      oldestLoadedMessageId: 'msg_1',
      isLoadingOlderMessages: true
    })

    await useChatStore.getState().loadOlderMessages()
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it('加载中途切会话丢弃结果', async () => {
    useChatStore.setState({
      currentSessionId: 'sess_1',
      messages: [{ id: 'msg_1', sessionId: 'sess_1', role: 'user', content: 'x', timestamp: 0, _revision: 0 }],
      hasMoreMessagesAbove: true,
      oldestLoadedMessageId: 'msg_1'
    })

    mockInvoke.mockImplementation(async () => {
      useChatStore.setState({ currentSessionId: 'sess_2' })
      return { messages: [{ id: 'msg_0', sessionId: 'sess_1', role: 'user', content: 'old', timestamp: 0 }], hasMore: false }
    })

    await useChatStore.getState().loadOlderMessages()

    expect(useChatStore.getState().messages).toHaveLength(1)
    expect(useChatStore.getState().messages[0].id).toBe('msg_1')
    expect(useChatStore.getState().isLoadingOlderMessages).toBe(false)
  })

  it('hasMore=false 且无守卫时不请求', async () => {
    useChatStore.setState({
      currentSessionId: 'sess_1',
      messages: [{ id: 'msg_1', sessionId: 'sess_1', role: 'user', content: 'x', timestamp: 0, _revision: 0 }],
      hasMoreMessagesAbove: false,
      oldestLoadedMessageId: 'msg_1'
    })

    await useChatStore.getState().loadOlderMessages()
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it('流式头部裁剪后同步 oldestLoadedMessageId，避免上滚补载出现空洞', () => {
    const msgs = Array.from({ length: 241 }, (_, i) => ({
      id: `msg_${i}`,
      sessionId: 'sess_1',
      role: (i % 2 === 0 ? 'user' : 'assistant') as const,
      content: `c${i}`,
      timestamp: i,
      _revision: 0
    }))
    const index = Object.fromEntries(msgs.map((m, i) => [m.id, i]))

    useChatStore.setState({
      currentSessionId: 'sess_1',
      messages: msgs,
      messageIndexById: index,
      oldestLoadedMessageId: 'msg_0',
      hasMoreMessagesAbove: false,
      suspendHeadTrim: false,
      isGenerating: true,
      currentGeneratingMessageId: 'msg_240'
    })

    useChatStore.getState().applyStreamDeltas([
      { kind: 'text', messageId: 'msg_240', delta: 'tail' }
    ])

    const state = useChatStore.getState()
    expect(state.messages.length).toBe(240)
    expect(state.messages[0].id).toBe('msg_1')
    expect(state.oldestLoadedMessageId).toBe('msg_1')
    expect(state.hasMoreMessagesAbove).toBe(true)
  })
})
