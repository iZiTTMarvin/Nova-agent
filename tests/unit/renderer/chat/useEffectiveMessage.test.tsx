// @vitest-environment jsdom

import React from 'react'
import { beforeEach, describe, expect, it } from 'vitest'
import { useEffectiveMessage } from '../../../../src/renderer/features/chat/useEffectiveMessage'
import { resetChatStoreForTests, useChatStore } from '../../../../src/renderer/stores/useChatStore'
import type { ExtendedMessage } from '../../../../src/renderer/stores/types'
import { act, renderDom } from '../renderDom'

function makeMessage(id: string): ExtendedMessage {
  return {
    id,
    sessionId: 'sess_render',
    role: 'assistant',
    content: '',
    thinking: '',
    blocks: [],
    toolCalls: [],
    timestamp: 0,
    _revision: 0
  }
}

/**
 * useEffectiveMessage 的核心契约：活跃消息（liveTurn 有条目）随 liveTurn 变化由 zustand
 * hook 独立驱动重渲染；非活跃消息选择器恒为 undefined，零重渲染。这是流式期间顶层
 * ChatPanel 不再每帧提交、同时活跃尾部仍能逐字推进的关键证据。
 */
describe('useEffectiveMessage 流式重渲染隔离', () => {
  beforeEach(() => {
    resetChatStoreForTests()
  })

  it('活跃消息随 liveTurn 重渲染、非活跃消息零重渲染、messages 引用稳定', () => {
    const active = makeMessage('msg_active')
    const inactive = makeMessage('msg_inactive')
    useChatStore.setState({
      currentSessionId: 'sess_render',
      messages: [active, inactive],
      messageIndexById: { msg_active: 0, msg_inactive: 1 }
    })

    const activeCount = { n: 0 }
    const inactiveCount = { n: 0 }

    const ActiveConsumer = () => {
      const effective = useEffectiveMessage(active)
      activeCount.n += 1
      return React.createElement('div', { 'data-testid': 'active' }, effective.content)
    }
    const InactiveConsumer = () => {
      const effective = useEffectiveMessage(inactive)
      inactiveCount.n += 1
      return React.createElement('div', { 'data-testid': 'inactive' }, effective.content)
    }

    const renderer = renderDom(
      React.createElement(
        React.Fragment,
        null,
        React.createElement(ActiveConsumer),
        React.createElement(InactiveConsumer)
      )
    )

    const activeBase = activeCount.n
    const inactiveBase = inactiveCount.n
    const messagesRefBefore = useChatStore.getState().messages

    // 每次单带 act()：一个 liveTurn 更新对应一次独立提交，便于精确计数重渲染。
    const DELTAS = 8
    for (let i = 0; i < DELTAS; i++) {
      act(() => {
        useChatStore.getState().applyStreamDeltas([
          { kind: 'text', messageId: 'msg_active', delta: 'x' }
        ])
      })
    }

    expect(activeCount.n - activeBase).toBe(DELTAS)
    expect(inactiveCount.n - inactiveBase).toBe(0)
    // 流式 text 只写 liveTurn，messages 数组引用恒定 —— 顶层不再每帧提交的根因。
    expect(useChatStore.getState().messages).toBe(messagesRefBefore)
    // 投影后活跃消息内容随字节累积
    expect(renderer.container.querySelector('[data-testid="active"]')?.textContent).toBe(
      'x'.repeat(DELTAS)
    )

    renderer.unmount()
  })
})
