import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  resetChatStoreForTests,
  useChatStore
} from '../../../../../src/renderer/stores/useChatStore'
import {
  resetWorkspaceStoreForTests,
  useWorkspaceStore
} from '../../../../../src/renderer/stores/useWorkspaceStore'

const mockInvoke = vi.fn()

function seedMessages(count: number) {
  const messages = Array.from({ length: count }, (_, i) => ({
    id: `msg_${i}`,
    sessionId: 'sess-1',
    role: (i % 2 === 0 ? 'user' : 'assistant') as const,
    content: `c_${i}`,
    timestamp: i,
    _revision: 0
  }))
  useChatStore.setState({
    currentSessionId: 'sess-1',
    messages,
    messageIndexById: Object.fromEntries(messages.map((m, i) => [m.id, i]))
  })
  return messages
}

describe('branchSlice', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    mockInvoke.mockReset()
    mockInvoke.mockImplementation(async (channel: string) =>
      channel === 'send-message' ? { accepted: true } : undefined
    )
    resetChatStoreForTests()
    resetWorkspaceStoreForTests()
    useWorkspaceStore.setState({ currentProjectPath: '/tmp/project' })
    global.window = {
      ...global.window,
      api: {
        invoke: mockInvoke,
        on: vi.fn(() => () => {}),
        removeAllListeners: vi.fn()
      }
    } as unknown as Window & typeof globalThis
  })

  it('regenerateAssistant 乐观截断，send 失败时回滚消息树并记录错误', async () => {
    const messages = seedMessages(4)
    vi.spyOn(useWorkspaceStore.getState(), 'prepareRegenerate').mockResolvedValue()
    vi.spyOn(useWorkspaceStore.getState(), 'bumpMessagesRevision').mockResolvedValue()
    mockInvoke.mockImplementation(async (channel: string) => {
      if (channel === 'send-message') throw new Error('IPC 断开')
      return undefined
    })

    await useChatStore.getState().regenerateAssistant('sess-1', 'msg_3')

    const state = useChatStore.getState()
    expect(state.messages).toEqual(messages)
    expect(state.messageIndexById).toEqual(
      Object.fromEntries(messages.map((m, i) => [m.id, i]))
    )
    expect(state.rollbackErrors.msg_3).toBe('IPC 断开')
    expect(state.branchForkInProgress).toBe(false)
    expect(state.sendInFlight).toBe(false)
    expect(state.pendingBranchMetaReload).toBe(false)
  })

  it('重新生成的迟到失败不能回滚已经切换到的新会话', async () => {
    seedMessages(4)
    vi.spyOn(useWorkspaceStore.getState(), 'prepareRegenerate').mockResolvedValue()
    let rejectOld!: (error: Error) => void
    mockInvoke.mockImplementation((channel: string, params?: { regenerate?: boolean; sessionId?: string }) => {
      if (channel === 'send-message') return params?.regenerate
        ? new Promise((_resolve, reject) => { rejectOld = reject }) : new Promise(() => {})
      if (channel === 'run:get-snapshot') return Promise.resolve({ snapshot: null, waitingSessions: [] })
      if (channel === 'load-session') return Promise.resolve({ id: params?.sessionId, messages: [] })
      return Promise.resolve([])
    })
    const old = useChatStore.getState().regenerateAssistant('sess-1', 'msg_3')
    await vi.waitFor(() => expect(rejectOld).toBeTypeOf('function'))
    useChatStore.getState().syncFromWorkspace({
      currentSessionId: 'sess-2', availableSessions: [], messagesRevision: 1,
      tier1BranchContext: null, tier1StaleDiffMessageIds: []
    })
    await vi.waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('load-session', { sessionId: 'sess-2' }))
    await vi.waitFor(() => expect(useWorkspaceStore.getState().isSessionLoading).toBe(false))
    void useChatStore.getState().sendMessage('新会话输入')
    await vi.waitFor(() => expect(useChatStore.getState().sendInFlight).toBe(true))
    rejectOld(new Error('旧重生成失败'))
    await old
    expect(useChatStore.getState().messages.map(message => message.content)).toEqual(['新会话输入'])
    expect(useChatStore.getState().sendInFlight).toBe(true)
    expect(useChatStore.getState().rollbackErrors).toEqual({})
  })

  it('regenerateAssistant 叶子 slash 已失效时回滚并展示拒绝原因', async () => {
    const messages = seedMessages(4)
    vi.spyOn(useWorkspaceStore.getState(), 'prepareRegenerate').mockResolvedValue()
    vi.spyOn(useWorkspaceStore.getState(), 'bumpMessagesRevision').mockResolvedValue()
    mockInvoke.mockImplementation(async (channel: string) => {
      if (channel === 'send-message') {
        return {
          accepted: false,
          rejection: { reason: 'not_found', skillName: 'gone', suggestions: [] }
        }
      }
      return undefined
    })

    await useChatStore.getState().regenerateAssistant('sess-1', 'msg_3')

    const state = useChatStore.getState()
    expect(state.messages).toEqual(messages)
    expect(state.rollbackErrors.msg_3).toContain('未找到技能 /gone')
    expect(state.branchForkInProgress).toBe(false)
    expect(state.sendInFlight).toBe(false)
    expect(state.pendingBranchMetaReload).toBe(false)
  })

  it('regenerateAssistant 成功路径乐观截断到目标消息之前', async () => {
    seedMessages(4)
    vi.spyOn(useWorkspaceStore.getState(), 'prepareRegenerate').mockResolvedValue()

    await useChatStore.getState().regenerateAssistant('sess-1', 'msg_3')

    const state = useChatStore.getState()
    expect(state.messages.map(m => m.id)).toEqual(['msg_0', 'msg_1', 'msg_2'])
    // send-message 在轮次结束后才返回 accepted，发送锁随之释放；分叉元信息仍等终态快照收口
    expect(state.sendInFlight).toBe(false)
    expect(state.pendingBranchMetaReload).toBe(true)
    expect(state.branchForkInProgress).toBe(true)
  })

  it('branchForkInProgress 期间 switchBranch 被拒', async () => {
    seedMessages(2)
    const wsSwitch = vi.spyOn(useWorkspaceStore.getState(), 'switchBranch').mockResolvedValue()
    useChatStore.setState({ branchForkInProgress: true })

    await useChatStore.getState().switchBranch('sess-1', 'msg_1')

    expect(wsSwitch).not.toHaveBeenCalled()
  })

  it('分叉准备窗口内 regenerateAssistant 被拒绝，不进入 prepare 与截断', async () => {
    const messages = seedMessages(4)
    const prepare = vi.spyOn(useWorkspaceStore.getState(), 'prepareRegenerate').mockResolvedValue()
    useChatStore.setState({ branchForkInProgress: true })

    await useChatStore.getState().regenerateAssistant('sess-1', 'msg_3')

    expect(prepare).not.toHaveBeenCalled()
    expect(useChatStore.getState().messages).toEqual(messages)
    expect(useChatStore.getState().sendInFlight).toBe(false)
  })

  it('分叉准备窗口内 editResend 被拒绝，不进入 prepare', async () => {
    const messages = seedMessages(4)
    const prepare = vi.spyOn(useWorkspaceStore.getState(), 'prepareEditResend').mockResolvedValue()
    useChatStore.setState({ branchForkInProgress: true })

    await useChatStore.getState().editResend('sess-1', 'msg_2', '改写后的内容')

    expect(prepare).not.toHaveBeenCalled()
    expect(useChatStore.getState().messages).toEqual(messages)
  })

  it('分叉准备窗口内普通 sendMessage 被拒，editResend 延续发送（带 rollbackSnapshot）放行', async () => {
    seedMessages(2)
    useChatStore.setState({ branchForkInProgress: true })
    mockInvoke.mockClear()

    const rejected = await useChatStore.getState().sendMessage('窗口内发送', [])
    expect(rejected).toBe(false)
    expect(mockInvoke).not.toHaveBeenCalled()

    mockInvoke.mockImplementation(async (channel: string) =>
      channel === 'send-message' ? { accepted: true } : undefined
    )
    const allowed = await useChatStore.getState().sendMessage('延续发送', [], {
      rollbackSnapshot: { messages: [], messageIndexById: {} }
    })
    expect(allowed).toBe(true)
    expect(mockInvoke).toHaveBeenCalledWith(
      'send-message',
      expect.objectContaining({ content: '延续发送', sessionId: 'sess-1' })
    )
  })

  it('editResend 发送失败时消息树恢复到截断前', async () => {
    const messages = seedMessages(4)
    vi.spyOn(useWorkspaceStore.getState(), 'prepareEditResend').mockResolvedValue()
    vi.spyOn(useWorkspaceStore.getState(), 'bumpMessagesRevision').mockResolvedValue()
    mockInvoke.mockImplementation(async (channel: string) => {
      if (channel === 'send-message') throw new Error('send 失败')
      return undefined
    })

    await useChatStore.getState().editResend('sess-1', 'msg_2', '改写后的内容')

    const state = useChatStore.getState()
    expect(state.messages).toEqual(messages)
    expect(state.branchForkInProgress).toBe(false)
    expect(state.sendInFlight).toBe(false)
    expect(Object.values(state.rollbackErrors)).toContain('send 失败')
  })

  it('finishBranchMetaRefresh 只在 pendingBranchMetaReload 为真时发起重拉', async () => {
    const bump = vi.spyOn(useWorkspaceStore.getState(), 'bumpMessagesRevision').mockResolvedValue()

    await useChatStore.getState().finishBranchMetaRefresh()
    expect(bump).not.toHaveBeenCalled()

    useChatStore.setState({ pendingBranchMetaReload: true })
    await useChatStore.getState().finishBranchMetaRefresh()

    expect(bump).toHaveBeenCalledTimes(1)
    expect(useChatStore.getState().pendingBranchMetaReload).toBe(false)
  })

  it('finishBranchMetaRefresh bump 失败时保留标记，下次调用重试、成功后清除', async () => {
    const bump = vi.spyOn(useWorkspaceStore.getState(), 'bumpMessagesRevision')
    bump.mockRejectedValueOnce(new Error('reload 失败'))
    useChatStore.setState({ pendingBranchMetaReload: true })

    await useChatStore.getState().finishBranchMetaRefresh()
    expect(useChatStore.getState().pendingBranchMetaReload).toBe(true)

    bump.mockResolvedValueOnce()
    await useChatStore.getState().finishBranchMetaRefresh()
    expect(bump).toHaveBeenCalledTimes(2)
    expect(useChatStore.getState().pendingBranchMetaReload).toBe(false)
  })
})
