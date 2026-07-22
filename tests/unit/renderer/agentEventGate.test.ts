import { describe, it, expect, beforeEach, vi } from 'vitest'
import { shouldHandleAgentEvent, gateAgentEvent } from '../../../src/renderer/lib/agentEventGate'
import { useChatStore, resetChatStoreForTests } from '../../../src/renderer/stores/useChatStore'

describe('agentEventGate', () => {
  beforeEach(() => {
    resetChatStoreForTests()
  })

  it('无 activeAgentSessionId 时接受事件', () => {
    useChatStore.setState({ currentSessionId: 's1', activeAgentSessionId: null })
    expect(shouldHandleAgentEvent('text-delta')).toBe(true)
  })

  it('事件归属会话与当前会话一致时接受', () => {
    useChatStore.setState({ currentSessionId: 's1', activeAgentSessionId: 's1' })
    expect(shouldHandleAgentEvent('text-delta')).toBe(true)
  })

  it('切走后丢弃旧会话事件', () => {
    useChatStore.setState({
      currentSessionId: 's2',
      activeAgentSessionId: 's1',
      isGenerating: true
    })
    expect(shouldHandleAgentEvent('text-delta')).toBe(false)
  })

  it('旧会话 message-end 被过滤并清理归属标记', () => {
    useChatStore.setState({
      currentSessionId: 's2',
      activeAgentSessionId: 's1',
      isGenerating: true,
      pendingUserMessages: [{ text: 'queued', images: [] }]
    })
    expect(shouldHandleAgentEvent('message-end')).toBe(false)
    expect(useChatStore.getState().activeAgentSessionId).toBeNull()
    expect(useChatStore.getState().isGenerating).toBe(false)
    // 排队消息不被 drain
    expect(useChatStore.getState().pendingUserMessages).toHaveLength(1)
  })

  it('事件自带 sessionId 等于当前会话 → 处理', () => {
    useChatStore.setState({ currentSessionId: 'focus', activeAgentSessionId: null })
    expect(shouldHandleAgentEvent('text-delta', 'focus')).toBe(true)
  })

  it('事件自带 sessionId 不等于当前会话 → 不处理（后台会话不进当前视图）', () => {
    useChatStore.setState({ currentSessionId: 'focus', activeAgentSessionId: null })
    expect(shouldHandleAgentEvent('text-delta', 'other')).toBe(false)
  })

  it('gateAgentEvent 按 payload.sessionId 路由', () => {
    useChatStore.setState({ currentSessionId: 'focus', activeAgentSessionId: null })
    const handler = vi.fn()
    const gated = gateAgentEvent('text-delta', handler)
    gated({ sessionId: 'other', delta: 'x' })
    expect(handler).not.toHaveBeenCalled()
    gated({ sessionId: 'focus', delta: 'y' })
    expect(handler).toHaveBeenCalledTimes(1)
  })
})
