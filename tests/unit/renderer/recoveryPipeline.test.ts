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

  it('handleMessageStart → handleError：不应产生重复消息（防止 React key 冲突）', async () => {
    // 复现路径：模型在返回任何内容前即报错
    // handleMessageStart 追加空气泡，handleError 应就地更新而非再追加
    useChatStore.getState().handleMessageStart('msg_dup')
    await useChatStore.getState().handleError('msg_dup', 'API error')

    const { messages, messageIndexById } = useChatStore.getState()
    const byId = messages.filter(m => m.id === 'msg_dup')
    expect(byId).toHaveLength(1)                    // 不能有两条相同 id
    expect(byId[0]!.isError).toBe(true)             // 应标记为错误
    expect(byId[0]!.content).toBe('API error')      // 错误内容应就地写入
    // messageIndexById 指向的索引应与实际消息位置一致
    const idx = messageIndexById['msg_dup']
    expect(idx).toBeDefined()
    expect(messages[idx!]?.id).toBe('msg_dup')
  })

  it('handleError 在无 handleMessageStart 的情况下应 fallback 追加（error 先于 message_start）', async () => {
    // 罕见情况：error 在 message_start 之前到达，此时列表里还没有这条消息
    await useChatStore.getState().handleError('msg_early_err', 'early error')

    const { messages } = useChatStore.getState()
    const byId = messages.filter(m => m.id === 'msg_early_err')
    expect(byId).toHaveLength(1)
    expect(byId[0]!.isError).toBe(true)
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
