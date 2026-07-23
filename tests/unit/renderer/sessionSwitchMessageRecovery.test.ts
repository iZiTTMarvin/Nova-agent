import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunSnapshot } from '../../../src/shared/run/types'
import type { WorkspaceState } from '../../../src/shared/workspace/types'
import {
  resetWorkspaceDispatcherForTests,
  dispatchWorkspaceChange
} from '../../../src/renderer/stores/workspaceDispatcher'
import {
  resetChatStoreForTests,
  useChatStore
} from '../../../src/renderer/stores/useChatStore'
import { useRunStore } from '../../../src/renderer/stores/useRunStore'

const sessionId = 'session-A'
const messageId = 'assistant-A'

const runningSnapshot: RunSnapshot = {
  runId: 'run-A',
  kind: 'agent',
  workspaceId: '/test/project',
  sessionId,
  messageId,
  status: 'running',
  sequence: 4,
  pendingInteractions: [],
  currentAttempt: null,
  progress: null,
  lastHeartbeatAt: 4,
  createdAt: 1,
  updatedAt: 4,
  turnStartedAt: 2,
  turnDraft: {
    messageId,
    attemptId: 'attempt-A',
    blocks: [
      { type: 'text', content: '已恢复的草稿' },
      {
        type: 'tool',
        toolCallId: 'tool-A',
        toolName: 'read',
        arguments: { path: 'README.md' },
        status: 'success',
        result: '文件内容'
      }
    ],
    finalized: false,
    updatedAt: 3
  }
}

function workspaceState(
  id = sessionId,
  messagesRevision = 1
): WorkspaceState {
  return {
    currentProjectPath: '/test/project',
    currentSessionId: id,
    currentMode: 'default',
    availableSessions: [
      {
        id,
        workspaceRoot: '/test/project',
        mode: 'default',
        createdAt: 1,
        updatedAt: 2,
        messageCount: 1,
        title: 'A'
      }
    ],
    messagesRevision,
    tier1BranchContext: null
  }
}

function sessionDetail(messages: Array<Record<string, unknown>>) {
  return {
    id: sessionId,
    workspaceRoot: '/test/project',
    mode: 'default' as const,
    createdAt: 1,
    updatedAt: 2,
    messageCount: messages.length,
    messages
  }
}

const userMessage = {
  id: 'user-A',
  sessionId,
  role: 'user',
  content: '开始',
  timestamp: 1
}

describe('运行中会话切回恢复', () => {
  beforeEach(() => {
    resetChatStoreForTests()
    resetWorkspaceDispatcherForTests()
    useRunStore.getState().resetForTests()
  })

  it('切回运行中会话时用 turnDraft 恢复 assistant 消息', async () => {
    global.window = {
      ...global.window,
      api: {
        invoke: vi.fn(async (channel: string) => {
          if (channel === 'run:get-snapshot') {
            return { snapshot: runningSnapshot, waitingSessions: [] }
          }
          if (channel === 'load-session') {
            return sessionDetail([userMessage])
          }
          if (channel === 'run:list-waiting') return []
          return undefined
        }),
        on: vi.fn(),
        removeAllListeners: vi.fn()
      }
    } as unknown as Window & typeof globalThis

    dispatchWorkspaceChange(workspaceState())

    await vi.waitFor(() => {
      const state = useChatStore.getState()
      expect(state.isGenerating).toBe(true)
      expect(state.currentGeneratingMessageId).toBe(messageId)
      expect(state.messages.map(message => message.id)).toEqual(['user-A', messageId])
      expect(state.messages[1]?.content).toBe('已恢复的草稿')
      expect(state.messages[1]?.toolCalls?.[0]).toMatchObject({
        id: 'tool-A',
        name: 'read',
        status: 'success',
        result: '文件内容'
      })
    })
  })

  it('错过 message_start 时首个 delta 自动创建 assistant 消息壳', () => {
    useChatStore.setState({
      currentSessionId: sessionId,
      messages: [userMessage],
      messageIndexById: { 'user-A': 0 },
      isGenerating: true,
      currentGeneratingMessageId: messageId
    })

    useChatStore.getState().applyStreamDeltas([
      { kind: 'text', messageId, delta: '继续输出' }
    ])

    const assistant = useChatStore.getState().messages.find(message => message.id === messageId)
    expect(assistant).toMatchObject({
      id: messageId,
      sessionId,
      role: 'assistant',
      content: '继续输出'
    })
  })

  it('迟到的 load-session 不能覆盖切回后已经收到的实时内容', async () => {
    let resolveLoad!: (value: ReturnType<typeof sessionDetail>) => void
    const delayedLoad = new Promise<ReturnType<typeof sessionDetail>>(resolve => {
      resolveLoad = resolve
    })

    global.window = {
      ...global.window,
      api: {
        invoke: vi.fn(async (channel: string) => {
          if (channel === 'run:get-snapshot') {
            return { snapshot: runningSnapshot, waitingSessions: [] }
          }
          if (channel === 'load-session') return delayedLoad
          if (channel === 'run:list-waiting') return []
          return undefined
        }),
        on: vi.fn(),
        removeAllListeners: vi.fn()
      }
    } as unknown as Window & typeof globalThis

    dispatchWorkspaceChange(workspaceState())
    useChatStore.getState().handleMessageStart(messageId)
    useChatStore.getState().applyStreamDeltas([
      { kind: 'text', messageId, delta: '实时内容' }
    ])
    resolveLoad(sessionDetail([userMessage]))

    await vi.waitFor(() => {
      const assistant = useChatStore.getState().messages.find(message => message.id === messageId)
      expect(assistant?.content).toBe('实时内容')
    })
  })

  it('message_end 后用持久化终态替换不完整的实时消息', async () => {
    const finalizedAssistant = {
      id: messageId,
      sessionId,
      role: 'assistant',
      content: '完整终态',
      timestamp: 3,
      blocks: [{ type: 'text', content: '完整终态' }]
    }
    global.window = {
      ...global.window,
      api: {
        invoke: vi.fn(async (channel: string) => {
          if (channel === 'load-session') {
            return sessionDetail([userMessage, finalizedAssistant])
          }
          if (channel === 'get-message-diffs') return { diffs: [], reviews: {} }
          return undefined
        }),
        on: vi.fn(),
        removeAllListeners: vi.fn()
      }
    } as unknown as Window & typeof globalThis

    useChatStore.setState({
      currentSessionId: sessionId,
      sessions: workspaceState().availableSessions,
      messages: [
        userMessage,
        {
          id: messageId,
          sessionId,
          role: 'assistant',
          content: '后半段',
          timestamp: 2,
          blocks: [{ type: 'text', content: '后半段' }],
          _revision: 0
        }
      ],
      messageIndexById: { 'user-A': 0, [messageId]: 1 },
      isGenerating: true,
      currentGeneratingMessageId: messageId
    })

    await useChatStore.getState().handleMessageEnd(messageId)

    expect(useChatStore.getState().messages.find(message => message.id === messageId)?.content)
      .toBe('完整终态')
  })

  it('同会话切分支时不保留旧 active path 的消息', async () => {
    const branchMessage = {
      id: 'branch-user',
      sessionId,
      role: 'user',
      content: '新分支',
      timestamp: 4
    }
    global.window = {
      ...global.window,
      api: {
        invoke: vi.fn(async (channel: string) => {
          if (channel === 'run:get-snapshot') {
            return { snapshot: null, waitingSessions: [] }
          }
          if (channel === 'load-session') {
            return sessionDetail([branchMessage])
          }
          return undefined
        }),
        on: vi.fn(),
        removeAllListeners: vi.fn()
      }
    } as unknown as Window & typeof globalThis

    useChatStore.setState({
      currentSessionId: sessionId,
      lastMessagesRevision: 1,
      messages: [userMessage],
      messageIndexById: { 'user-A': 0 }
    })

    useChatStore.getState().syncFromWorkspace(workspaceState(sessionId, 2))

    await vi.waitFor(() => {
      expect(useChatStore.getState().messages.map(message => message.id)).toEqual(['branch-user'])
    })
  })

  it('快速切换后迟到的旧会话加载结果不能覆盖当前会话', async () => {
    const otherSessionId = 'session-B'
    const otherMessage = {
      id: 'user-B',
      sessionId: otherSessionId,
      role: 'user',
      content: 'B 会话',
      timestamp: 5
    }
    let resolveFirstLoad!: (value: ReturnType<typeof sessionDetail>) => void
    const firstLoad = new Promise<ReturnType<typeof sessionDetail>>(resolve => {
      resolveFirstLoad = resolve
    })

    global.window = {
      ...global.window,
      api: {
        invoke: vi.fn(async (channel: string, payload?: { sessionId?: string }) => {
          if (channel === 'run:get-snapshot') {
            return { snapshot: null, waitingSessions: [] }
          }
          if (channel === 'load-session' && payload?.sessionId === sessionId) {
            return firstLoad
          }
          if (channel === 'load-session' && payload?.sessionId === otherSessionId) {
            return {
              ...sessionDetail([otherMessage]),
              id: otherSessionId
            }
          }
          return undefined
        }),
        on: vi.fn(),
        removeAllListeners: vi.fn()
      }
    } as unknown as Window & typeof globalThis

    dispatchWorkspaceChange(workspaceState(sessionId, 1))
    await vi.waitFor(() => {
      expect(useRunStore.getState().selectedSessionId).toBe(sessionId)
    })
    dispatchWorkspaceChange(workspaceState(otherSessionId, 1))

    await vi.waitFor(() => {
      expect(useChatStore.getState().messages.map(message => message.id)).toEqual(['user-B'])
    })
    resolveFirstLoad(sessionDetail([userMessage]))
    await Promise.resolve()

    expect(useChatStore.getState().currentSessionId).toBe(otherSessionId)
    expect(useChatStore.getState().messages.map(message => message.id)).toEqual(['user-B'])
  })
})
