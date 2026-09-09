import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useChatStore, resetChatStoreForTests } from '../../../src/renderer/stores/useChatStore'
import { useWorkspaceStore } from '../../../src/renderer/stores/useWorkspaceStore'
import { useRunStore, selectSessionIsRunning } from '../../../src/renderer/stores/useRunStore'
import { makeRunSnapshot, publishRunSnapshot } from './runSnapshotFixture'

const mockInvoke = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  resetChatStoreForTests()
  useRunStore.getState().resetForTests()
  useWorkspaceStore.setState({ currentProjectPath: '/test/project', currentSessionId: 'sess_1' })
  useChatStore.setState({ currentSessionId: 'sess_1' })
  global.window = {
    ...global.window,
    api: { invoke: mockInvoke, on: vi.fn(), removeAllListeners: vi.fn() }
  } as unknown as Window & typeof globalThis
  mockInvoke.mockImplementation(async (channel: string) => {
    if (channel === 'send-message') return { accepted: true }
    if (channel === 'load-session') return { messages: useChatStore.getState().messages, hasMoreMessagesAbove: false }
    if (channel === 'get-message-diffs') return { diffs: [], reviews: {} }
    return undefined
  })
  useRunStore.getState().selectSession('sess_1')
})

function startTurn(): void {
  publishRunSnapshot(makeRunSnapshot())
  useChatStore.getState().handleMessageStart('msg_1')
}

function sentContents(): unknown[] {
  return mockInvoke.mock.calls.filter(([channel]) => channel === 'send-message').map(([, payload]) => payload.content)
}

describe('Steering Queue', () => {
  it('入队、按索引移除和清空不改变其余消息的顺序', () => {
    for (const text of ['Q1', 'Q2', 'Q3']) useChatStore.getState().enqueuePendingMessage(text, [])
    useChatStore.getState().removePendingMessage(1)
    expect(useChatStore.getState().pendingUserMessages.map(item => item.text)).toEqual(['Q1', 'Q3'])
    useChatStore.getState().clearPendingMessages()
    expect(useChatStore.getState().pendingUserMessages).toEqual([])
  })

  it.each(['cancelled', 'interrupted'] as const)('%s 快照保留队列，显式继续才发出', async status => {
    startTurn()
    useChatStore.getState().enqueuePendingMessage('补充要求', [])
    publishRunSnapshot(makeRunSnapshot({ status, sequence: 2 }))
    await vi.waitFor(() => expect(useChatStore.getState().messages[0].interrupted).toBe(true))
    expect(useChatStore.getState().pendingUserMessages.map(item => item.text)).toEqual(['补充要求'])
    expect(sentContents()).toEqual([])
    await useChatStore.getState().sendNextPendingMessage()
    expect(sentContents()).toEqual(['补充要求'])
    expect(useChatStore.getState().pendingUserMessages).toEqual([])
  })

  it.each(['completed', 'failed'] as const)('只有首次 %s 快照派发队首，消息事件和重复快照不重复派发', async status => {
    startTurn()
    useChatStore.getState().enqueuePendingMessage('Q1', [])
    useChatStore.getState().enqueuePendingMessage('Q2', [])
    await useChatStore.getState().handleMessageEnd('msg_1')
    await useChatStore.getState().handleError('msg_1', '连接失败')
    expect(selectSessionIsRunning(useRunStore.getState(), 'sess_1')).toBe(true)
    expect(sentContents()).toEqual([])
    const terminal = makeRunSnapshot({ status, sequence: 2 })
    publishRunSnapshot(terminal)
    await vi.waitFor(() => expect(sentContents()).toEqual(['Q1']))
    publishRunSnapshot(terminal)
    publishRunSnapshot({ ...terminal, sequence: 3 })
    await useRunStore.getState().refreshInteractionProjection()
    expect(sentContents()).toEqual(['Q1'])
    expect(useChatStore.getState().pendingUserMessages.map(item => item.text)).toEqual(['Q2'])
    expect(useChatStore.getState().messages.filter(message => message.role === 'user').map(message => message.content)).toEqual(['Q1'])
  })

  it('终态消息对账未完成时也派发队首，恢复对账后不重复发送', async () => {
    startTurn()
    useChatStore.getState().enqueuePendingMessage('Q1', [])
    let resolveLoad!: (detail: { messages: []; hasMoreMessagesAbove: false }) => void
    mockInvoke.mockImplementation(async (channel: string) => {
      if (channel === 'send-message') return { accepted: true }
      if (channel === 'load-session') return new Promise(resolve => { resolveLoad = resolve })
      if (channel === 'get-message-diffs') return { diffs: [], reviews: {} }
      return undefined
    })
    publishRunSnapshot(makeRunSnapshot({ status: 'completed', sequence: 2 }))
    await vi.waitFor(() => expect(sentContents()).toEqual(['Q1']))
    expect(useChatStore.getState().pendingUserMessages).toEqual([])
    resolveLoad({ messages: [], hasMoreMessagesAbove: false })
    await vi.waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('get-message-diffs', expect.anything()))
    expect(sentContents()).toEqual(['Q1'])
    expect(useChatStore.getState().messages.filter(message => message.role === 'user').map(message => message.content)).toEqual(['Q1'])
  })

  it('队列超过上限时丢弃最早的项', () => {
    for (let i = 0; i < 25; i++) useChatStore.getState().enqueuePendingMessage(`msg-${i}`, [])
    expect(useChatStore.getState().pendingUserMessages.map(item => item.text)).toEqual(
      Array.from({ length: 20 }, (_, index) => `msg-${index + 5}`)
    )
  })

  it('运行中显式派发被守卫拒绝，不丢失队列', async () => {
    startTurn()
    useChatStore.getState().enqueuePendingMessage('Q1', [])
    useChatStore.getState().enqueuePendingMessage('Q2', [])
    await useChatStore.getState().sendNextPendingMessage()
    expect(useChatStore.getState().pendingUserMessages.map(item => item.text)).toEqual(['Q1', 'Q2'])
    expect(sentContents()).toEqual([])
  })

  it('派发入口抛错时消息放回队首，下次派发保持顺序', async () => {
    useChatStore.getState().enqueuePendingMessage('Q1', [])
    useChatStore.getState().enqueuePendingMessage('Q2', [])
    const send = vi.spyOn(useChatStore.getState(), 'sendMessage').mockRejectedValueOnce(new Error('发送前失败'))
    try {
      await useChatStore.getState().sendNextPendingMessage()
      expect(useChatStore.getState().pendingUserMessages.map(item => item.text)).toEqual(['Q1', 'Q2'])
      expect(sentContents()).toEqual([])
    } finally {
      send.mockRestore()
    }
    await useChatStore.getState().sendNextPendingMessage()
    expect(sentContents()).toEqual(['Q1'])
    expect(useChatStore.getState().pendingUserMessages.map(item => item.text)).toEqual(['Q2'])
  })
})
