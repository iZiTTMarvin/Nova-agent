import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { selectSessionIsRunning, useRunStore } from '../../../src/renderer/stores/useRunStore'
import { resetChatStoreForTests, useChatStore } from '../../../src/renderer/stores/useChatStore'
import { useWorkspaceStore } from '../../../src/renderer/stores/useWorkspaceStore'
import type { RunSnapshot } from '../../../src/shared/run/types'

const invoke = vi.fn()
function makeSnap(runId: string, sessionId: string, sequence: number, status: RunSnapshot['status'] = 'running', createdAt = 1): RunSnapshot {
  return {
    runId, sessionId, sequence, status, createdAt, updatedAt: sequence,
    kind: 'agent', workspaceId: '/ws', messageId: `msg_${runId}`,
    pendingInteractions: [], currentAttempt: null, progress: null, lastHeartbeatAt: 1
  }
}
function publish(snapshot: RunSnapshot): void {
  useRunStore.getState().handleSnapshotEvent(snapshot, { sequence: snapshot.sequence, type: 'snapshot', at: snapshot.updatedAt })
}
function focus(sessionId: string): void {
  useChatStore.setState({ currentSessionId: sessionId })
  useRunStore.getState().selectSession(sessionId)
}

beforeEach(() => {
  resetChatStoreForTests()
  useRunStore.getState().resetForTests()
  useWorkspaceStore.setState({ currentProjectPath: '/ws' })
  invoke.mockReset().mockImplementation(async (channel, params) => {
    if (channel === 'run:get-snapshot') return { snapshot: null, waitingSessions: [] }
    if (channel === 'run:list-waiting') return []
    if (channel === 'load-session') return { id: params.sessionId, messages: [] }
    if (channel === 'get-message-diffs') return { diffs: [], reviews: {} }
    return undefined
  })
  global.window = { ...global.window, api: { invoke, on: vi.fn(), removeAllListeners: vi.fn() } } as unknown as Window & typeof globalThis
})
afterEach(() => vi.restoreAllMocks())

describe('Renderer 按 run/session 隔离权威投影', () => {
  it('A/B 正常跳号互不串扰，查询 B 不改变 A 的选择或展示', async () => {
    focus('sessA')
    publish(makeSnap('runA', 'sessA', 1))
    publish(makeSnap('runB', 'sessB', 1))
    publish(makeSnap('runB', 'sessB', 9))
    expect(invoke).not.toHaveBeenCalledWith('run:get-snapshot', { sessionId: 'sessB' })
    invoke.mockResolvedValueOnce({ snapshot: makeSnap('runB', 'sessB', 10), waitingSessions: [] })
    await useRunStore.getState().pullSnapshot('sessB')
    expect(useRunStore.getState().selectedSessionId).toBe('sessA')
    expect(useRunStore.getState().snapshot?.runId).toBe('runA')
    expect(useRunStore.getState().lastSequenceByRunId).toEqual({ runA: 1, runB: 10 })
    publish(makeSnap('runA', 'sessA', 5, 'completed'))
    expect(selectSessionIsRunning(useRunStore.getState(), 'sessA')).toBe(false)
    expect(selectSessionIsRunning(useRunStore.getState(), 'sessB')).toBe(true)
  })

  it('A 的拉取响应迟到不覆盖后来选中的 B', async () => {
    focus('sessA')
    let resolveA!: (value: unknown) => void
    invoke.mockImplementation((channel, params) => {
      if (channel === 'run:get-snapshot' && params.sessionId === 'sessA') return new Promise(resolve => { resolveA = resolve })
      return Promise.resolve({ snapshot: makeSnap('runB', 'sessB', 1), waitingSessions: [] })
    })
    const pull = useRunStore.getState().pullSnapshot('sessA')
    focus('sessB')
    await useRunStore.getState().pullSnapshot('sessB')
    resolveA({ snapshot: makeSnap('runA', 'sessA', 9), waitingSessions: [] })
    await pull
    expect(useRunStore.getState().snapshot?.runId).toBe('runB')
    expect(useRunStore.getState().snapshotsByRunId.runA.sequence).toBe(9)
  })

  it.each(['old', 'null'] as const)('查询中的新广播优先于迟到的 %s 响应', async response => {
    focus('sessA')
    let resolvePull!: (value: unknown) => void
    invoke.mockImplementation(() => new Promise(resolve => { resolvePull = resolve }))
    const pull = useRunStore.getState().pullSnapshot('sessA')
    publish(makeSnap('new', 'sessA', 1, 'running', 2))
    resolvePull({ snapshot: response === 'old' ? makeSnap('old', 'sessA', 5, 'interrupted', 1) : null, waitingSessions: [] })
    await pull
    expect(useRunStore.getState().snapshot?.runId).toBe('new')
    expect(useRunStore.getState().snapshot?.status).toBe('running')
  })

  it('未知 runId 的取消按显式选中会话收敛，不接受别的会话终态', async () => {
    focus('sessA')
    useChatStore.setState({ sendInFlight: true, currentGeneratingMessageId: 'msg_runA' })
    useRunStore.getState().beginLocalCancel(null)
    publish(makeSnap('runB', 'sessB', 2, 'cancelled'))
    expect(useRunStore.getState().cancelling).toBe(true)
    publish(makeSnap('runA', 'sessA', 2, 'cancelled'))
    await vi.waitFor(() => expect(useChatStore.getState().sendInFlight).toBe(false))
    expect(useRunStore.getState().cancelling).toBe(false)
    expect(useChatStore.getState().currentGeneratingMessageId).toBeNull()
    useRunStore.getState().beginLocalCancel('runA')
    expect(useRunStore.getState().cancelling).toBe(false)
  })

  it('后台 A 取消确认不会停止前台 B；cancelling 快照仍属于运行中', async () => {
    focus('sessA')
    publish(makeSnap('runA', 'sessA', 1, 'cancelling'))
    useRunStore.getState().beginLocalCancel('runA')
    expect(selectSessionIsRunning(useRunStore.getState(), 'sessA')).toBe(true)
    focus('sessB')
    publish(makeSnap('runB', 'sessB', 1))
    useChatStore.getState().handleMessageStart('msg_runB')
    publish(makeSnap('runA', 'sessA', 2, 'cancelled'))
    await Promise.resolve()
    expect(useRunStore.getState().cancelling).toBe(false)
    expect(selectSessionIsRunning(useRunStore.getState(), 'sessB')).toBe(true)
    expect(useChatStore.getState().currentGeneratingMessageId).toBe('msg_runB')
  })

  it('message-end 缺失且对账失败时，terminal 仍结束 busy 并保留流式回答', async () => {
    focus('sessA')
    publish(makeSnap('runA', 'sessA', 1))
    useChatStore.getState().handleMessageStart('msg_runA')
    useChatStore.getState().applyStreamDeltas([{ kind: 'text', messageId: 'msg_runA', delta: '保留回答' }])
    invoke.mockRejectedValue(new Error('对账不可用'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    publish(makeSnap('runA', 'sessA', 8, 'completed'))
    expect(selectSessionIsRunning(useRunStore.getState(), 'sessA')).toBe(false)
    await vi.waitFor(() => expect(useChatStore.getState().currentGeneratingMessageId).toBeNull())
    expect(useChatStore.getState().sendInFlight).toBe(false)
    expect(useChatStore.getState().liveTurn).toEqual({})
    expect(useChatStore.getState().messages[0].blocks).toContainEqual({ type: 'text', content: '保留回答' })
    expect(selectSessionIsRunning(useRunStore.getState(), 'sessA')).toBe(false)
  })

  it.each([
    ['sessB', 'throw'], ['sessB', 'reject'], ['sessA', 'throw'], ['sessA', 'reject']
  ] as const)('旧发送 %s / %s 回执不能修改新会话生命周期的草稿和发送锁', async (target, failure) => {
    focus('sessA')
    let finishOld!: (value: unknown) => void
    let rejectOld!: (error: Error) => void
    let sendCount = 0
    invoke.mockImplementation((channel, params) => {
      if (channel === 'send-message') {
        sendCount++
        return sendCount === 1
          ? new Promise((resolve, reject) => { finishOld = resolve; rejectOld = reject })
          : new Promise(() => {})
      }
      if (channel === 'load-session') return Promise.resolve({ id: params.sessionId, messages: [] })
      if (channel === 'run:get-snapshot') return Promise.resolve({ snapshot: null, waitingSessions: [] })
      return Promise.resolve([])
    })
    const firstSend = useChatStore.getState().sendMessage('旧输入')
    await vi.waitFor(() => expect(sendCount).toBe(1))
    const switchTo = async (sessionId: string) => {
      useChatStore.getState().syncFromWorkspace({
        currentSessionId: sessionId, availableSessions: [], messagesRevision: 1,
        tier1BranchContext: null, tier1StaleDiffMessageIds: []
      })
      await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('load-session', { sessionId }))
      await vi.waitFor(() => expect(useWorkspaceStore.getState().isSessionLoading).toBe(false))
    }
    await switchTo('sessB')
    if (target === 'sessA') await switchTo('sessA')
    void useChatStore.getState().sendMessage('新输入')
    await vi.waitFor(() => expect(sendCount).toBe(2))
    const requestId = useChatStore.getState().sendRequestId
    if (failure === 'throw') rejectOld(new Error('旧发送失败'))
    else finishOld({ accepted: false, rejection: { reason: 'not_found', skillName: 'gone', suggestions: [] } })
    await firstSend
    expect(useChatStore.getState().currentSessionId).toBe(target)
    expect(useChatStore.getState().sendRequestId).toBe(requestId)
    expect(useChatStore.getState().sendInFlight).toBe(true)
    expect(useChatStore.getState().messages.map(message => message.content)).toEqual(['新输入'])
  })

  it('首次 terminal 单独推进队列，不等待水合，也不被 message-end 或 outbox 再次推进', async () => {
    focus('sessA')
    publish(makeSnap('runA', 'sessA', 1))
    useChatStore.getState().handleMessageStart('msg_runA')
    useChatStore.getState().enqueuePendingMessage('Q1', [])
    useChatStore.getState().enqueuePendingMessage('Q2', [])
    invoke.mockImplementation(channel => channel === 'load-session' || channel === 'send-message'
      ? new Promise(() => {}) : Promise.resolve([]))
    publish(makeSnap('runA', 'sessA', 2, 'completed'))
    await vi.waitFor(() => expect(invoke.mock.calls.filter(([channel]) => channel === 'send-message')).toHaveLength(1))
    publish(makeSnap('runA', 'sessA', 9, 'completed'))
    void useChatStore.getState().handleMessageEnd('msg_runA')
    await Promise.resolve()
    expect(invoke.mock.calls.filter(([channel]) => channel === 'send-message')).toHaveLength(1)
    expect(useChatStore.getState().pendingUserMessages.map(message => message.text)).toEqual(['Q2'])
    expect(useChatStore.getState().sendInFlight).toBe(true)
  })
})
