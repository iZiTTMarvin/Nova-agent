import { describe, it, expect, beforeEach, vi } from 'vitest'
import { shouldHandleAgentEvent, gateAgentEvent } from '../../../src/renderer/lib/agentEventGate'
import { useChatStore, resetChatStoreForTests } from '../../../src/renderer/stores/useChatStore'
import type { Session } from '../../../src/shared/session/types'

function primarySession(id: string): Session {
  return {
    id,
    workspaceRoot: 'w',
    mode: 'default',
    createdAt: 1,
    updatedAt: 1,
    messageCount: 0,
    kind: 'primary'
  }
}

function subagentSession(id: string, parentId: string): Session {
  return {
    id,
    workspaceRoot: 'w',
    mode: 'default',
    createdAt: 1,
    updatedAt: 1,
    messageCount: 0,
    kind: 'subagent',
    subagent: {
      lineage: { parentSessionId: parentId, depth: 1 },
      profile: { profileId: 'explore', name: 'Explore', permissionCeiling: 'read_only' }
    }
  }
}

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

  it('旧会话 message-end 被过滤且不修改当前投影', () => {
    useChatStore.setState({
      currentSessionId: 's2',
      activeAgentSessionId: 's1',
      isGenerating: true,
      pendingUserMessages: [{ text: 'queued', images: [] }]
    })
    expect(shouldHandleAgentEvent('message-end')).toBe(false)
    expect(useChatStore.getState().activeAgentSessionId).toBe('s1')
    expect(useChatStore.getState().isGenerating).toBe(true)
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

  it('后台会话终态不能清掉当前会话的生成态', () => {
    useChatStore.setState({
      currentSessionId: 'focus',
      activeAgentSessionId: 'other',
      isGenerating: true,
      currentGeneratingMessageId: 'focus-message'
    })

    expect(shouldHandleAgentEvent('message-end', 'other')).toBe(false)
    expect(useChatStore.getState()).toMatchObject({
      activeAgentSessionId: 'other',
      isGenerating: true,
      currentGeneratingMessageId: 'focus-message'
    })
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

  describe('子代理权限请求放行到父会话视图', () => {
    it('子代理事件带直接父会话归属 → 放行', () => {
      useChatStore.setState({
        currentSessionId: 's1',
        activeAgentSessionId: 's1',
        sessions: [primarySession('s1'), subagentSession('s2', 's1')]
      })
      expect(shouldHandleAgentEvent('permission-request', 's2', 's1')).toBe(true)
    })

    it('会话列表尚未包含子会话、事件带直父归属 → 仍放行（不依赖列表时序）', () => {
      useChatStore.setState({
        currentSessionId: 's1',
        activeAgentSessionId: 's1',
        sessions: [primarySession('s1')]
      })
      expect(shouldHandleAgentEvent('permission-request', 's2', 's1')).toBe(true)
    })

    it('更深层后代权限请求按血缘回溯放行', () => {
      useChatStore.setState({
        currentSessionId: 's1',
        activeAgentSessionId: 's1',
        sessions: [primarySession('s1'), subagentSession('s2', 's1'), subagentSession('s3', 's2')]
      })
      expect(shouldHandleAgentEvent('permission-request', 's3', 's2')).toBe(true)
      // 无直父归属字段时回退血缘回溯
      expect(shouldHandleAgentEvent('permission-request', 's3')).toBe(true)
    })

    it('非后代会话的权限请求仍被丢弃', () => {
      useChatStore.setState({
        currentSessionId: 's1',
        activeAgentSessionId: 's1',
        sessions: [primarySession('s1'), subagentSession('s2', 's1')]
      })
      // 无直父归属且血缘无关 → 丢弃
      expect(shouldHandleAgentEvent('permission-request', 'other')).toBe(false)
      // 直父归属不是当前会话、血缘回溯也达不到 → 丢弃
      expect(shouldHandleAgentEvent('permission-request', 'other', 's0')).toBe(false)
    })

    it('后代会话的非权限事件仍按普通规则丢弃', () => {
      useChatStore.setState({
        currentSessionId: 's1',
        activeAgentSessionId: 's1',
        sessions: [primarySession('s1'), subagentSession('s2', 's1')]
      })
      expect(shouldHandleAgentEvent('text-delta', 's2', 's1')).toBe(false)
      expect(shouldHandleAgentEvent('tool_call', 's2', 's1')).toBe(false)
    })

    it('gateAgentEvent 对放行的子代理权限请求实际调用 handler', () => {
      useChatStore.setState({
        currentSessionId: 's1',
        activeAgentSessionId: 's1',
        sessions: [primarySession('s1')]
      })
      const handler = vi.fn()
      const gated = gateAgentEvent('permission-request', handler)
      gated({ sessionId: 's2', parentSessionId: 's1', requestId: 'perm-x', toolName: 'bash' })
      expect(handler).toHaveBeenCalledTimes(1)

      const denied = vi.fn()
      const gatedDenied = gateAgentEvent('permission-request', denied)
      gatedDenied({ sessionId: 'other', parentSessionId: 's0', requestId: 'perm-y' })
      expect(denied).not.toHaveBeenCalled()
    })
  })
})
