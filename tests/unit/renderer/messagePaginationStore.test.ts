import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useChatStore, resetChatStoreForTests } from '../../../src/renderer/stores/useChatStore'
import { SESSION_HISTORY_PAGE_SIZE } from '../../../src/shared/session/messagePagination'

const mockInvoke = vi.fn()

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

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

  it.each([
    { currentSessionId: null, oldestLoadedMessageId: 'msg_1' },
    { currentSessionId: 'sess_1', oldestLoadedMessageId: null }
  ])('缺少 session 或游标时不请求：%o', async ({ currentSessionId, oldestLoadedMessageId }) => {
    useChatStore.setState({
      currentSessionId,
      messages: [{ id: 'msg_1', sessionId: 'sess_1', role: 'user', content: 'x', timestamp: 0, _revision: 0 }],
      hasMoreMessagesAbove: true,
      oldestLoadedMessageId
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
      // workspace session reset 会先清掉旧会话的 loading。
      useChatStore.setState({ currentSessionId: 'sess_2', isLoadingOlderMessages: false })
      return { messages: [{ id: 'msg_0', sessionId: 'sess_1', role: 'user', content: 'old', timestamp: 0 }], hasMore: false }
    })

    await useChatStore.getState().loadOlderMessages()

    expect(useChatStore.getState().messages).toHaveLength(1)
    expect(useChatStore.getState().messages[0].id).toBe('msg_1')
    expect(useChatStore.getState().isLoadingOlderMessages).toBe(false)
  })

  it('切换后的迟到成功不能清掉新会话的 loading', async () => {
    useChatStore.setState({
      currentSessionId: 'sess_1',
      hasMoreMessagesAbove: true,
      oldestLoadedMessageId: 'msg_1'
    })
    mockInvoke.mockImplementation(async () => {
      useChatStore.setState({
        currentSessionId: 'sess_2',
        isLoadingOlderMessages: true
      })
      return { messages: [], hasMore: false }
    })

    await useChatStore.getState().loadOlderMessages()

    expect(useChatStore.getState().currentSessionId).toBe('sess_2')
    expect(useChatStore.getState().isLoadingOlderMessages).toBe(true)
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

  it('空页只更新 hasMore 并结束 loading', async () => {
    useChatStore.setState({
      currentSessionId: 'sess_1',
      messages: [{ id: 'msg_1', sessionId: 'sess_1', role: 'user', content: 'x', timestamp: 0, _revision: 0 }],
      messageIndexById: { msg_1: 0 },
      hasMoreMessagesAbove: true,
      oldestLoadedMessageId: 'msg_1'
    })
    mockInvoke.mockResolvedValue({ messages: [], hasMore: false })

    await useChatStore.getState().loadOlderMessages()

    const state = useChatStore.getState()
    expect(state.messages.map(message => message.id)).toEqual(['msg_1'])
    expect(state.oldestLoadedMessageId).toBe('msg_1')
    expect(state.hasMoreMessagesAbove).toBe(false)
    expect(state.isLoadingOlderMessages).toBe(false)
    expect(state.suspendHeadTrim).toBe(false)
  })

  it('当前会话补载失败时结束 loading', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    useChatStore.setState({
      currentSessionId: 'sess_1',
      hasMoreMessagesAbove: true,
      oldestLoadedMessageId: 'msg_1'
    })
    mockInvoke.mockRejectedValue(new Error('page unavailable'))

    try {
      await useChatStore.getState().loadOlderMessages()
    } finally {
      consoleError.mockRestore()
    }

    expect(useChatStore.getState().isLoadingOlderMessages).toBe(false)
  })

  it('切换后的迟到错误不能清掉新会话的 loading', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    useChatStore.setState({
      currentSessionId: 'sess_1',
      hasMoreMessagesAbove: true,
      oldestLoadedMessageId: 'msg_1'
    })
    mockInvoke.mockImplementation(async () => {
      useChatStore.setState({
        currentSessionId: 'sess_2',
        isLoadingOlderMessages: true
      })
      throw new Error('old page failed')
    })

    try {
      await useChatStore.getState().loadOlderMessages()
    } finally {
      consoleError.mockRestore()
    }

    expect(useChatStore.getState().currentSessionId).toBe('sess_2')
    expect(useChatStore.getState().isLoadingOlderMessages).toBe(true)
  })

  it('同会话 revision 变化后丢弃旧 active path 的迟到成功', async () => {
    const oldPage = deferred<{
      messages: Array<{ id: string; sessionId: string; role: 'user'; content: string; timestamp: number }>
      hasMore: boolean
    }>()
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'load-session-messages') return oldPage.promise
      if (channel === 'load-session') return new Promise(() => {})
      return Promise.resolve(undefined)
    })
    useChatStore.setState({
      currentSessionId: 'sess_1',
      lastMessagesRevision: 1,
      messages: [{ id: 'old-current', sessionId: 'sess_1', role: 'user', content: 'old', timestamp: 1, _revision: 0 }],
      messageIndexById: { 'old-current': 0 },
      hasMoreMessagesAbove: true,
      oldestLoadedMessageId: 'old-current'
    })

    const loadPromise = useChatStore.getState().loadOlderMessages()
    useChatStore.getState().syncFromWorkspace({
      currentSessionId: 'sess_1',
      availableSessions: [],
      messagesRevision: 2,
      tier1BranchContext: null
    })
    useChatStore.setState({
      messages: [{ id: 'new-current', sessionId: 'sess_1', role: 'user', content: 'new', timestamp: 2, _revision: 0 }],
      messageIndexById: { 'new-current': 0 },
      isLoadingOlderMessages: true
    })
    oldPage.resolve({
      messages: [{ id: 'old-page', sessionId: 'sess_1', role: 'user', content: 'old page', timestamp: 0 }],
      hasMore: false
    })
    await loadPromise

    expect(useChatStore.getState().messages.map(message => message.id)).toEqual(['new-current'])
    expect(useChatStore.getState().isLoadingOlderMessages).toBe(true)
  })

  it('同会话 revision 变化后旧分页异常不能清掉新请求的 loading', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const oldPage = deferred<never>()
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'load-session-messages') return oldPage.promise
      if (channel === 'load-session') return new Promise(() => {})
      return Promise.resolve(undefined)
    })
    useChatStore.setState({
      currentSessionId: 'sess_1',
      lastMessagesRevision: 1,
      hasMoreMessagesAbove: true,
      oldestLoadedMessageId: 'old-current'
    })

    const loadPromise = useChatStore.getState().loadOlderMessages()
    useChatStore.getState().syncFromWorkspace({
      currentSessionId: 'sess_1',
      availableSessions: [],
      messagesRevision: 2,
      tier1BranchContext: null
    })
    useChatStore.setState({ isLoadingOlderMessages: true })
    oldPage.reject(new Error('old page failed'))
    try {
      await loadPromise
    } finally {
      consoleError.mockRestore()
    }

    expect(useChatStore.getState().isLoadingOlderMessages).toBe(true)
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

    useChatStore.getState().handleToolCallStart('msg_240', 'tc_trim', 'write')
    // toolCall delta 写回 messages（经 commitMessageList 不跳过裁剪）→ 超 240 触发头部裁剪
    useChatStore.getState().applyStreamDeltas([
      { kind: 'toolCall', messageId: 'msg_240', toolCallId: 'tc_trim', delta: '{"path":"a.ts"}' }
    ])

    const state = useChatStore.getState()
    expect(state.messages.length).toBe(240)
    expect(state.messages[0].id).toBe('msg_1')
    expect(state.oldestLoadedMessageId).toBe('msg_1')
    expect(state.hasMoreMessagesAbove).toBe(true)
  })
})
