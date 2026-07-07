import { describe, it, expect, beforeEach } from 'vitest'
import { shouldHandleAgentEvent } from '../../../src/renderer/lib/agentEventGate'
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
})
