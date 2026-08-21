import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  resetChatStoreForTests,
  useChatStore
} from '../../../../../src/renderer/stores/useChatStore'
import { useRunStore } from '../../../../../src/renderer/stores/useRunStore'
import type { RunSnapshot } from '../../../../../src/shared/run/types'

function unresolved<T>(): Promise<T> {
  return new Promise<T>(() => {})
}

function snap(
  partial: Partial<RunSnapshot> & Pick<RunSnapshot, 'runId' | 'sessionId' | 'sequence' | 'status'>
): RunSnapshot {
  return {
    kind: 'agent',
    workspaceId: '/ws',
    messageId: 'm',
    pendingInteractions: [],
    currentAttempt: null,
    progress: null,
    lastHeartbeatAt: 1,
    createdAt: 1,
    updatedAt: 1,
    ...partial
  }
}

describe('chat workspace sync reset ownership', () => {
  beforeEach(() => {
    resetChatStoreForTests()
    global.window = {
      ...global.window,
      api: {
        invoke: vi.fn((channel: string) => {
          if (channel === 'load-session') return unresolved()
          if (channel === 'run:get-snapshot') {
            return Promise.resolve({ snapshot: null, waitingSessions: [] })
          }
          if (channel === 'run:list-waiting') return Promise.resolve([])
          return Promise.resolve(undefined)
        }),
        on: vi.fn(() => () => {}),
        removeAllListeners: vi.fn()
      }
    } as unknown as Window & typeof globalThis
  })

  it('切会话精确清理瞬态，同时保留不属于切换 reset 的状态', () => {
    const loadingDiffs = new Set(['message-a'])
    useChatStore.setState({
      sessions: [{ id: 'session-a', workspaceRoot: 'w', mode: 'default', createdAt: 1, updatedAt: 1, messageCount: 1 }],
      currentSessionId: 'session-a',
      lastMessagesRevision: 1,
      messages: [{ id: 'message-a', sessionId: 'session-a', role: 'assistant', content: 'a', timestamp: 1, _revision: 0 }],
      messageIndexById: { 'message-a': 0 },
      pendingBranchMetaReload: true,
      branchForkInProgress: true,
      tier1BranchContext: { branchMessageId: 'message-a', branchType: 'tier1', siblingCount: 2, selectedSiblingIndex: 1 },
      isGenerating: true,
      currentGeneratingMessageId: 'message-a',
      activeAgentSessionId: 'session-a',
      sendInFlight: true,
      pendingUserMessages: [{ text: 'queued', images: [] }],
      streamingToolArgs: { tool: '{"path":' },
      liveTurn: { 'message-a': { type: 'text', content: 'streaming tail' } },
      messageDiffs: { 'message-a': { diffs: [], reviews: {} } },
      loadingDiffs,
      loadingDiffPlaceholders: { 'message-a': [{ filePath: 'a.ts', status: 'modified' }] },
      rollbackErrors: { 'message-a': 'rollback failed' },
      hasMoreMessagesAbove: true,
      isLoadingOlderMessages: true,
      oldestLoadedMessageId: 'message-a',
      suspendHeadTrim: true,
      recoveryState: { 'message-a': 'recovering' },
      recoveryHints: { 'message-a': [{ hint: 'retry', attempt: 1 }] },
      hookErrors: { 'message-a': [{ hookEvent: 'tool_before', error: 'hook failed' }] }
    })
    let notifications = 0
    const unsubscribe = useChatStore.subscribe(() => {
      notifications++
    })

    useChatStore.getState().syncFromWorkspace({
      currentSessionId: 'session-b',
      availableSessions: [{ id: 'session-b', workspaceRoot: 'w', mode: 'default', createdAt: 2, updatedAt: 2, messageCount: 0 }],
      messagesRevision: 2,
      tier1BranchContext: null
    })
    unsubscribe()

    const state = useChatStore.getState()
    expect(notifications).toBe(2)
    expect(state.currentSessionId).toBe('session-b')
    expect(state.lastMessagesRevision).toBe(2)
    expect(state.messages).toEqual([])
    expect(state.messageIndexById).toEqual({})
    expect(state.branchForkInProgress).toBe(false)
    expect(state.pendingBranchMetaReload).toBe(true)
    expect(state.tier1BranchContext).toBeNull()
    expect(state.isGenerating).toBe(false)
    expect(state.currentGeneratingMessageId).toBeNull()
    expect(state.activeAgentSessionId).toBeNull()
    expect(state.sendInFlight).toBe(false)
    expect(state.pendingUserMessages).toEqual([])
    expect(state.streamingToolArgs).toEqual({})
    expect(state.liveTurn).toEqual({})
    expect(state.messageDiffs).toEqual({})
    expect(state.loadingDiffs.size).toBe(0)
    expect(state.loadingDiffs).not.toBe(loadingDiffs)
    expect(state.loadingDiffPlaceholders).toEqual({})
    expect(state.rollbackErrors).toEqual({})
    expect(state.hasMoreMessagesAbove).toBe(false)
    expect(state.isLoadingOlderMessages).toBe(false)
    expect(state.oldestLoadedMessageId).toBeNull()
    expect(state.suspendHeadTrim).toBe(false)
    expect(state.recoveryState['message-a']).toBe('recovering')
    expect(state.recoveryHints['message-a']).toEqual([{ hint: 'retry', attempt: 1 }])
    expect(state.hookErrors['message-a']).toEqual([{ hookEvent: 'tool_before', error: 'hook failed' }])
  })

  it('同会话 revision 变化只清消息序列相关投影，不清轮次与队列状态', () => {
    const message = { id: 'message-a', sessionId: 'session-a', role: 'assistant' as const, content: 'a', timestamp: 1, _revision: 0 }
    useChatStore.setState({
      currentSessionId: 'session-a',
      lastMessagesRevision: 1,
      messages: [message],
      messageIndexById: { 'message-a': 0 },
      isGenerating: true,
      currentGeneratingMessageId: 'message-a',
      activeAgentSessionId: 'session-a',
      sendInFlight: true,
      pendingUserMessages: [{ text: 'queued', images: [] }],
      branchForkInProgress: true,
      streamingToolArgs: { tool: '{}' },
      messageDiffs: { 'message-a': { diffs: [], reviews: {} } },
      loadingDiffs: new Set(['message-a']),
      loadingDiffPlaceholders: { 'message-a': [{ filePath: 'a.ts', status: 'modified' }] },
      rollbackErrors: { 'message-a': 'rollback failed' },
      hasMoreMessagesAbove: true,
      isLoadingOlderMessages: true,
      oldestLoadedMessageId: 'message-a',
      suspendHeadTrim: true
    })

    useChatStore.getState().syncFromWorkspace({
      currentSessionId: 'session-a',
      availableSessions: [],
      messagesRevision: 2,
      tier1BranchContext: null
    })

    const state = useChatStore.getState()
    expect(state.messages).toEqual([message])
    expect(state.messageIndexById).toEqual({ 'message-a': 0 })
    expect(state.isGenerating).toBe(true)
    expect(state.currentGeneratingMessageId).toBe('message-a')
    expect(state.activeAgentSessionId).toBe('session-a')
    expect(state.sendInFlight).toBe(true)
    expect(state.pendingUserMessages).toEqual([{ text: 'queued', images: [] }])
    expect(state.branchForkInProgress).toBe(true)
    expect(state.streamingToolArgs).toEqual({ tool: '{}' })
    expect(state.messageDiffs).toEqual({})
    expect(state.loadingDiffs.size).toBe(0)
    expect(state.loadingDiffPlaceholders).toEqual({})
    expect(state.rollbackErrors).toEqual({})
    expect(state.hasMoreMessagesAbove).toBe(false)
    expect(state.isLoadingOlderMessages).toBe(false)
    expect(state.oldestLoadedMessageId).toBeNull()
    expect(state.suspendHeadTrim).toBe(false)
  })

  it('切到无会话时在两个原子 patch 内清空会话投影', () => {
    useChatStore.setState({
      currentSessionId: 'session-a',
      lastMessagesRevision: 1,
      messages: [{ id: 'message-a', sessionId: 'session-a', role: 'user', content: 'a', timestamp: 1, _revision: 0 }],
      messageIndexById: { 'message-a': 0 },
      messageDiffs: { 'message-a': { diffs: [], reviews: {} } },
      loadingDiffs: new Set(['message-a']),
      hasMoreMessagesAbove: true,
      oldestLoadedMessageId: 'message-a'
    })
    let notifications = 0
    const unsubscribe = useChatStore.subscribe(() => {
      notifications++
    })

    useChatStore.getState().syncFromWorkspace({
      currentSessionId: null,
      availableSessions: [],
      messagesRevision: 2,
      tier1BranchContext: null
    })
    unsubscribe()

    expect(notifications).toBe(2)
    expect(useChatStore.getState()).toMatchObject({
      currentSessionId: null,
      messages: [],
      messageIndexById: {},
      messageDiffs: {},
      hasMoreMessagesAbove: false,
      oldestLoadedMessageId: null
    })
    expect(useChatStore.getState().loadingDiffs.size).toBe(0)
  })

  it('切到收尾会话：message-end 先到而 pull 快照过期时，水合不复活 isGenerating', async () => {
    const runningSnapshot = snap({
      runId: 'run-b',
      sessionId: 'session-b',
      sequence: 10,
      status: 'running',
      messageId: 'message-b'
    })
    const terminalSnapshot = snap({
      runId: 'run-b',
      sessionId: 'session-b',
      sequence: 12,
      status: 'completed',
      messageId: 'message-b'
    })

    let resolvePull!: (value: { snapshot: RunSnapshot; waitingSessions: unknown[] }) => void
    const pendingPull = new Promise<{ snapshot: RunSnapshot; waitingSessions: unknown[] }>(
      (resolve) => {
        resolvePull = resolve
      }
    )
    const snapshotCalls: Array<string | undefined> = []

    vi.mocked(window.api.invoke).mockImplementation((channel: string, params: unknown) => {
      const p = params as { sessionId?: string } | undefined
      if (channel === 'load-session') {
        return Promise.resolve({
          id: 'session-b',
          workspaceRoot: 'w',
          mode: 'default',
          createdAt: 2,
          updatedAt: 2,
          messageCount: 0,
          kind: 'primary',
          messages: []
        })
      }
      if (channel === 'run:get-snapshot') {
        snapshotCalls.push(p?.sessionId)
        // 第一次调用是 pullSnapshot：挂起，模拟响应晚于 terminal 事件；
        // 第二次是水合前的终态复核。
        if (snapshotCalls.length === 1) return pendingPull
        return Promise.resolve({ snapshot: terminalSnapshot, waitingSessions: [] })
      }
      return Promise.resolve(undefined)
    })

    useRunStore.getState().resetForTests()
    useChatStore.setState({
      sessions: [
        { id: 'session-a', workspaceRoot: 'w', mode: 'default', createdAt: 1, updatedAt: 1, messageCount: 1 }
      ],
      currentSessionId: 'session-a',
      lastMessagesRevision: 1,
      messages: [],
      messageIndexById: {}
    })

    useChatStore.getState().syncFromWorkspace({
      currentSessionId: 'session-b',
      availableSessions: [
        { id: 'session-b', workspaceRoot: 'w', mode: 'default', createdAt: 2, updatedAt: 2, messageCount: 0 }
      ],
      messagesRevision: 2,
      tier1BranchContext: null
    })

    // pull 尚未返回：目标轮次先结束，renderer 已回到非生成态
    await useChatStore.getState().handleMessageEnd('message-b')
    expect(useChatStore.getState().isGenerating).toBe(false)

    // 过期的 running 快照此时才到达
    resolvePull({ snapshot: runningSnapshot, waitingSessions: [] })

    // 先等水合完成：终态复核（第二次 run:get-snapshot）已发出，
    // 再断言生成态未被过期的 running 快照复活
    await vi.waitFor(() => {
      expect(snapshotCalls.length).toBeGreaterThanOrEqual(2)
    })
    expect(snapshotCalls).toEqual(['session-b', 'session-b'])
    await vi.waitFor(() => {
      expect(useChatStore.getState().isGenerating).toBe(false)
    })
    expect(useChatStore.getState().currentGeneratingMessageId).toBeNull()
    expect(useChatStore.getState().activeAgentSessionId).toBeNull()
  })

  it('load-session 失败时保留已完成的 session/reset 状态且不产生未处理拒绝', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(window.api.invoke).mockImplementation((channel: string) => {
      if (channel === 'load-session') return Promise.reject(new Error('session unavailable'))
      if (channel === 'run:get-snapshot') {
        return Promise.resolve({ snapshot: null, waitingSessions: [] })
      }
      return Promise.resolve(undefined)
    })
    useChatStore.setState({
      currentSessionId: 'session-a',
      lastMessagesRevision: 1,
      messageDiffs: { 'message-a': { diffs: [], reviews: {} } },
      loadingDiffs: new Set(['message-a'])
    })

    try {
      useChatStore.getState().syncFromWorkspace({
        currentSessionId: 'session-b',
        availableSessions: [],
        messagesRevision: 2,
        tier1BranchContext: null
      })
      await vi.waitFor(() => {
        expect(consoleError).toHaveBeenCalled()
      })
    } finally {
      consoleError.mockRestore()
    }

    expect(useChatStore.getState().currentSessionId).toBe('session-b')
    expect(useChatStore.getState().messageDiffs).toEqual({})
    expect(useChatStore.getState().loadingDiffs.size).toBe(0)
  })
})
