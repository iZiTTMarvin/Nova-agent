import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  resetChatStoreForTests,
  useChatStore
} from '../../../../../src/renderer/stores/useChatStore'

describe('streamSlice', () => {
  beforeEach(() => {
    resetChatStoreForTests()
  })

  it('applyStreamDeltas 一次调用只产生一次 Store 订阅通知', () => {
    useChatStore.getState().handleMessageStart('msg_batch')
    const subscriber = vi.fn()
    const unsubscribe = useChatStore.subscribe(subscriber)

    useChatStore.getState().applyStreamDeltas([
      { kind: 'thinking', messageId: 'msg_batch', delta: '先分析' },
      { kind: 'thinking', messageId: 'msg_batch', delta: '上下文' },
      { kind: 'text', messageId: 'msg_batch', delta: '结论' },
      { kind: 'text', messageId: 'msg_batch', delta: '完成' }
    ])

    expect(subscriber).toHaveBeenCalledTimes(1)
    unsubscribe()
  })

  it('纯 text/thinking delta 只写活跃回合：messages 引用稳定，liveTurn 累积', () => {
    useChatStore.getState().handleMessageStart('msg_text')
    useChatStore.getState().handleMessageStart('msg_thinking')
    const messagesRefBefore = useChatStore.getState().messages

    useChatStore.getState().applyStreamDeltas([
      { kind: 'text', messageId: 'msg_text', delta: 'a' },
      { kind: 'thinking', messageId: 'msg_thinking', delta: 'x' }
    ])
    // messages 完全没动 —— 顶层不再因流式文本每帧重提交
    expect(useChatStore.getState().messages).toBe(messagesRefBefore)
    expect(useChatStore.getState().liveTurn['msg_text']).toMatchObject({ type: 'text', content: 'a' })
    expect(useChatStore.getState().liveTurn['msg_thinking']).toMatchObject({ type: 'thinking', content: 'x' })
    const liveTextRef = useChatStore.getState().liveTurn['msg_text']

    useChatStore.getState().applyStreamDeltas([
      { kind: 'text', messageId: 'msg_text', delta: 'b' },
      { kind: 'thinking', messageId: 'msg_thinking', delta: 'y' }
    ])
    expect(useChatStore.getState().messages).toBe(messagesRefBefore)
    expect(useChatStore.getState().liveTurn['msg_text']).toMatchObject({ type: 'text', content: 'ab' })
    expect(useChatStore.getState().liveTurn['msg_thinking']).toMatchObject({ type: 'thinking', content: 'xy' })
    // 活跃块每批是新引用，订阅才能感知并驱动活跃 MessageItem 重渲染
    expect(useChatStore.getState().liveTurn['msg_text']).not.toBe(liveTextRef)
  })

  it('迟到 partial delta 不覆盖已 finalize 的完整 arguments', () => {
    useChatStore.getState().handleMessageStart('msg_tool')
    useChatStore.getState().handleToolCallStart('msg_tool', 'tool_1', 'write')
    useChatStore.getState().applyStreamDeltas([
      {
        kind: 'toolCall',
        messageId: 'msg_tool',
        toolCallId: 'tool_1',
        delta: '{"content":"partial'
      }
    ])
    useChatStore.getState().handleToolCall('msg_tool', 'tool_1', 'write', {
      path: 'index.html',
      content: 'complete'
    })

    useChatStore.getState().applyStreamDeltas([
      {
        kind: 'toolCall',
        messageId: 'msg_tool',
        toolCallId: 'tool_1',
        delta: '-late"}'
      }
    ])

    const message = useChatStore.getState().messages[0]
    const toolBlock = message.blocks?.find(
      block => block.type === 'tool' && block.toolCallId === 'tool_1'
    )
    const toolCall = message.toolCalls?.find(call => call.id === 'tool_1')
    expect(toolBlock).toMatchObject({
      arguments: { path: 'index.html', content: 'complete' }
    })
    expect(toolCall?.arguments).toEqual({
      path: 'index.html',
      content: 'complete'
    })
  })
})
