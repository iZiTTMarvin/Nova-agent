import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useChatStore, resetChatStoreForTests } from '../../../src/renderer/stores/useChatStore'

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

describe('useChatStore recovery / hookError handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetChatStoreForTests()
  })

  it('handleRecoveryState 应按 messageId 写入恢复状态', () => {
    useChatStore.getState().handleRecoveryState('msg_1', {
      kind: 'retrying',
      attempt: 2,
      lastError: '429 Too Many Requests',
      maxAttempts: 3
    })

    expect(useChatStore.getState().recoveryState.msg_1).toEqual({
      kind: 'retrying',
      attempt: 2,
      lastError: '429 Too Many Requests',
      maxAttempts: 3
    })
  })

  it('handleRecoveryHint 应累积多条提示', () => {
    useChatStore.getState().handleRecoveryHint('msg_1', 'hint A', 1)
    useChatStore.getState().handleRecoveryHint('msg_1', 'hint B', 2)

    expect(useChatStore.getState().recoveryHints.msg_1).toEqual([
      { hint: 'hint A', attempt: 1 },
      { hint: 'hint B', attempt: 2 }
    ])
  })

  it('handleHookError 应累积 Hook 异常记录', () => {
    useChatStore.getState().handleHookError('msg_1', 'postToolUse', 'timeout')
    useChatStore.getState().handleHookError('msg_1', 'onError', 'crash')

    expect(useChatStore.getState().hookErrors.msg_1).toEqual([
      { hookEvent: 'postToolUse', error: 'timeout' },
      { hookEvent: 'onError', error: 'crash' }
    ])
  })

  it('handleRecoveryState 应接受 failed kind', () => {
    useChatStore.getState().handleRecoveryState('msg_fail', {
      kind: 'failed',
      error: '重试 3 次后仍失败: timeout'
    })

    expect(useChatStore.getState().recoveryState.msg_fail).toEqual({
      kind: 'failed',
      error: '重试 3 次后仍失败: timeout'
    })
  })

  it('handleError 应清理该 messageId 的恢复状态（error 路径无 message-end）', () => {
    useChatStore.getState().handleRecoveryState('msg_err', {
      kind: 'failed',
      error: 'network error'
    })
    useChatStore.getState().handleRecoveryHint('msg_err', 'hint', 3)

    useChatStore.getState().handleError('msg_err', 'network error')

    const state = useChatStore.getState()
    expect(state.recoveryState.msg_err).toBeUndefined()
    expect(state.recoveryHints.msg_err).toBeUndefined()
    expect(state.isGenerating).toBe(false)
  })

  it('handleMessageEnd 应清理该 messageId 的恢复 / hook 状态', async () => {
    useChatStore.getState().handleMessageStart('msg_end')
    useChatStore.getState().handleRecoveryState('msg_end', {
      kind: 'recovering',
      fromMessageId: ''
    })
    useChatStore.getState().handleRecoveryHint('msg_end', 'compressing', 0)
    useChatStore.getState().handleHookError('msg_end', 'context', 'warn')

    mockInvoke.mockResolvedValue({ diffs: [], reviews: {} })
    await useChatStore.getState().handleMessageEnd('msg_end')

    const state = useChatStore.getState()
    expect(state.recoveryState.msg_end).toBeUndefined()
    expect(state.recoveryHints.msg_end).toBeUndefined()
    expect(state.hookErrors.msg_end).toBeUndefined()
    expect(state.isGenerating).toBe(false)
  })
})
