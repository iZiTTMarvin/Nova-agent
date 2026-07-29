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

  it('连续 text 与 thinking delta 保持最后一个 block 对象引用不变', () => {
    useChatStore.getState().handleMessageStart('msg_text')
    useChatStore.getState().handleMessageStart('msg_thinking')
    useChatStore.getState().applyStreamDeltas([
      { kind: 'text', messageId: 'msg_text', delta: 'a' },
      { kind: 'thinking', messageId: 'msg_thinking', delta: 'x' }
    ])

    const textBlock = useChatStore.getState().messages.find(message => message.id === 'msg_text')?.blocks?.at(-1)
    const thinkingBlock = useChatStore.getState().messages.find(message => message.id === 'msg_thinking')?.blocks?.at(-1)

    useChatStore.getState().applyStreamDeltas([
      { kind: 'text', messageId: 'msg_text', delta: 'b' },
      { kind: 'thinking', messageId: 'msg_thinking', delta: 'y' }
    ])

    const nextTextBlock = useChatStore.getState().messages.find(message => message.id === 'msg_text')?.blocks?.at(-1)
    const nextThinkingBlock = useChatStore.getState().messages.find(message => message.id === 'msg_thinking')?.blocks?.at(-1)
    expect(nextTextBlock).toBe(textBlock)
    expect(nextTextBlock).toMatchObject({ type: 'text', content: 'ab' })
    expect(nextThinkingBlock).toBe(thinkingBlock)
    expect(nextThinkingBlock).toMatchObject({ type: 'thinking', content: 'xy' })
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
