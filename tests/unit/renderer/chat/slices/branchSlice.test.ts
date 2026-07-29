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
    mockInvoke.mockResolvedValue(undefined)
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
    expect(state.isGenerating).toBe(false)
    expect(state.pendingBranchMetaReload).toBe(false)
  })

  it('regenerateAssistant 成功路径乐观截断到目标消息之前', async () => {
    seedMessages(4)
    vi.spyOn(useWorkspaceStore.getState(), 'prepareRegenerate').mockResolvedValue()

    await useChatStore.getState().regenerateAssistant('sess-1', 'msg_3')

    const state = useChatStore.getState()
    expect(state.messages.map(m => m.id)).toEqual(['msg_0', 'msg_1', 'msg_2'])
    expect(state.isGenerating).toBe(true)
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
    expect(state.isGenerating).toBe(false)
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
})
