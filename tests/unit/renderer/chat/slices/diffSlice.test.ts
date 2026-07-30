import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  resetChatStoreForTests,
  useChatStore
} from '../../../../../src/renderer/stores/useChatStore'

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

function switchAwayFromCurrentSession(): void {
  useChatStore.getState().syncFromWorkspace({
    currentSessionId: null,
    availableSessions: [],
    messagesRevision: useChatStore.getState().lastMessagesRevision + 1,
    tier1BranchContext: null
  })
}

describe('chat diff slice generation fence', () => {
  const mockInvoke = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    resetChatStoreForTests()
    global.window = {
      ...global.window,
      api: {
        invoke: mockInvoke,
        on: vi.fn(() => () => {}),
        removeAllListeners: vi.fn()
      }
    } as unknown as Window & typeof globalThis
    useChatStore.setState({
      currentSessionId: 'session-a',
      lastMessagesRevision: 1
    })
  })

  it('切会话后丢弃迟到的 diff 加载结果', async () => {
    const pending = deferred<{
      diffs: Array<{ filePath: string; status: 'modified'; hunks: [] }>
      reviews: Record<string, never>
    }>()
    mockInvoke.mockReturnValueOnce(pending.promise)

    const loadPromise = useChatStore.getState().loadMessageDiffs('session-a', 'message-a')
    expect(useChatStore.getState().loadingDiffs.has('message-a')).toBe(true)

    switchAwayFromCurrentSession()
    pending.resolve({
      diffs: [{ filePath: 'src/a.ts', status: 'modified', hunks: [] }],
      reviews: {}
    })
    await loadPromise

    expect(useChatStore.getState().messageDiffs['message-a']).toBeUndefined()
    expect(useChatStore.getState().loadingDiffs.has('message-a')).toBe(false)
  })

  it('同会话 revision 变化后丢弃旧 active path 的 diff 结果', async () => {
    const pendingDiff = deferred<{
      diffs: Array<{ filePath: string; status: 'modified'; hunks: [] }>
      reviews: Record<string, never>
    }>()
    const pendingSession = deferred<never>()
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'get-message-diffs') return pendingDiff.promise
      if (channel === 'load-session') return pendingSession.promise
      return Promise.resolve(undefined)
    })

    const loadPromise = useChatStore.getState().loadMessageDiffs('session-a', 'message-a')
    useChatStore.getState().syncFromWorkspace({
      currentSessionId: 'session-a',
      availableSessions: [],
      messagesRevision: 2,
      tier1BranchContext: null
    })
    pendingDiff.resolve({
      diffs: [{ filePath: 'src/old-branch.ts', status: 'modified', hunks: [] }],
      reviews: {}
    })
    await loadPromise

    expect(useChatStore.getState().messageDiffs['message-a']).toBeUndefined()
    expect(useChatStore.getState().loadingDiffs.has('message-a')).toBe(false)
  })

  it.each([
    {
      name: 'acceptFile',
      channel: 'accept-file',
      invoke: () => useChatStore.getState().acceptFile('session-a', 'message-a', 'src/a.ts'),
      result: undefined
    },
    {
      name: 'rejectFile',
      channel: 'reject-file',
      invoke: () => useChatStore.getState().rejectFile('session-a', 'message-a', 'src/a.ts'),
      result: undefined
    },
    {
      name: 'acceptAllFiles',
      channel: 'accept-all-files',
      invoke: () => useChatStore.getState().acceptAllFiles('session-a', 'message-a', ['src/a.ts']),
      result: undefined
    },
    {
      name: 'rejectAllFiles',
      channel: 'reject-all-files',
      invoke: () => useChatStore.getState().rejectAllFiles('session-a', 'message-a', ['src/a.ts']),
      result: { restored: ['src/a.ts'], failed: [] }
    }
  ])('$name 切会话后不把迟到结果写回新会话', async ({ invoke, result }) => {
    useChatStore.setState({
      messageDiffs: {
        'message-a': {
          diffs: [{ filePath: 'src/a.ts', status: 'modified', hunks: [] }],
          reviews: {}
        }
      }
    })
    const pending = deferred<unknown>()
    mockInvoke.mockReturnValueOnce(pending.promise)

    const reviewPromise = invoke()
    switchAwayFromCurrentSession()
    pending.resolve(result)
    await reviewPromise

    expect(useChatStore.getState().messageDiffs).toEqual({})
  })

  it.each([
    {
      name: 'loadMessageDiffs',
      invoke: () => useChatStore.getState().loadMessageDiffs('session-a', 'message-a')
    },
    {
      name: 'acceptFile',
      invoke: () => useChatStore.getState().acceptFile('session-a', 'message-a', 'src/a.ts')
    },
    {
      name: 'rejectFile',
      invoke: () => useChatStore.getState().rejectFile('session-a', 'message-a', 'src/a.ts')
    },
    {
      name: 'acceptAllFiles',
      invoke: () => useChatStore.getState().acceptAllFiles('session-a', 'message-a', ['src/a.ts'])
    },
    {
      name: 'rejectAllFiles',
      invoke: () => useChatStore.getState().rejectAllFiles('session-a', 'message-a', ['src/a.ts'])
    }
  ])('$name 调用开始时 session 参数已过期则不发 IPC', async ({ invoke }) => {
    useChatStore.setState({
      currentSessionId: 'session-b',
      messageDiffs: {
        'message-b': {
          diffs: [{ filePath: 'src/b.ts', status: 'modified', hunks: [] }],
          reviews: {}
        }
      }
    })

    await invoke()

    expect(mockInvoke).not.toHaveBeenCalled()
    expect(useChatStore.getState().messageDiffs).toEqual({
      'message-b': {
        diffs: [{ filePath: 'src/b.ts', status: 'modified', hunks: [] }],
        reviews: {}
      }
    })
    expect(useChatStore.getState().loadingDiffs.size).toBe(0)
  })

  it('无效 diff payload 只清 loading，不写坏缓存', async () => {
    mockInvoke.mockResolvedValueOnce({ diffs: null })

    await useChatStore.getState().loadMessageDiffs('session-a', 'message-a')

    expect(useChatStore.getState().messageDiffs['message-a']).toBeUndefined()
    expect(useChatStore.getState().loadingDiffs.has('message-a')).toBe(false)
  })

  it('diff 加载失败不抛错并清理当前 generation 的 loading', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    mockInvoke.mockRejectedValueOnce(new Error('diff unavailable'))

    try {
      await expect(
        useChatStore.getState().loadMessageDiffs('session-a', 'message-a')
      ).resolves.toBeUndefined()
    } finally {
      consoleError.mockRestore()
    }

    expect(useChatStore.getState().messageDiffs['message-a']).toBeUndefined()
    expect(useChatStore.getState().loadingDiffs.has('message-a')).toBe(false)
  })
})
