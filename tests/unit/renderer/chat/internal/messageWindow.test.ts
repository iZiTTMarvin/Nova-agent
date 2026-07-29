import { describe, expect, it } from 'vitest'
import {
  MESSAGE_WINDOW_MAX_SIZE,
  MESSAGE_WINDOW_TAIL_PRESERVE
} from '../../../../../src/renderer/stores/chat/constants'
import {
  applyMessageWindowTrim,
  buildMessageIndex,
  paginationPatchAfterHeadTrim,
  trimMessageWindow
} from '../../../../../src/renderer/stores/chat/internal'
import type { ExtendedMessage } from '../../../../../src/renderer/stores/chat/types'

function makeMessages(count: number): ExtendedMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `msg-${i}`,
    sessionId: 's1',
    role: 'assistant' as const,
    content: `content-${i}`,
    timestamp: i,
    _revision: 0
  }))
}

describe('trimMessageWindow', () => {
  it('恰好 240 条时不裁剪，原引用透传', () => {
    const messages = makeMessages(MESSAGE_WINDOW_MAX_SIZE)
    const index = buildMessageIndex(messages)
    const result = trimMessageWindow(messages, index)

    expect(result.headTrimmed).toBe(false)
    expect(result.messages).toBe(messages)
    expect(result.index).toBe(index)
  })

  it('241 条时从头部裁掉 1 条，窗口回到 240 条', () => {
    const messages = makeMessages(MESSAGE_WINDOW_MAX_SIZE + 1)
    const result = trimMessageWindow(messages, buildMessageIndex(messages))

    expect(result.headTrimmed).toBe(true)
    expect(result.messages).toHaveLength(MESSAGE_WINDOW_MAX_SIZE)
    expect(result.messages[0].id).toBe('msg-1')
    expect(result.messages[result.messages.length - 1].id).toBe(`msg-${MESSAGE_WINDOW_MAX_SIZE}`)
  })

  it('大幅超阈值时窗口回到 240 条，而非只保留尾部 80 条', () => {
    const messages = makeMessages(300)
    const result = trimMessageWindow(messages, buildMessageIndex(messages))

    expect(result.headTrimmed).toBe(true)
    expect(result.messages).toHaveLength(MESSAGE_WINDOW_MAX_SIZE)
    expect(result.messages).not.toHaveLength(MESSAGE_WINDOW_TAIL_PRESERVE)
    expect(result.messages[0].id).toBe('msg-60')
  })

  it('裁剪后索引与消息数组保持一致', () => {
    const messages = makeMessages(MESSAGE_WINDOW_MAX_SIZE + 5)
    const result = trimMessageWindow(messages, buildMessageIndex(messages))

    expect(Object.keys(result.index)).toHaveLength(result.messages.length)
    for (let i = 0; i < result.messages.length; i++) {
      expect(result.index[result.messages[i].id]).toBe(i)
    }
  })
})

describe('paginationPatchAfterHeadTrim', () => {
  it('未裁剪时返回空 patch', () => {
    const messages = makeMessages(3)
    const patch = paginationPatchAfterHeadTrim({ messages, headTrimmed: false })

    expect(patch).toEqual({})
  })

  it('裁剪后游标指向新窗口首条并标记可上滚补载', () => {
    const messages = makeMessages(MESSAGE_WINDOW_MAX_SIZE + 1)
    const trimmed = trimMessageWindow(messages, buildMessageIndex(messages))
    const patch = paginationPatchAfterHeadTrim(trimmed)

    expect(patch).toEqual({
      oldestLoadedMessageId: 'msg-1',
      hasMoreMessagesAbove: true
    })
  })

  it('裁剪后窗口为空时游标为 null', () => {
    const patch = paginationPatchAfterHeadTrim({ messages: [], headTrimmed: true })

    expect(patch).toEqual({
      oldestLoadedMessageId: null,
      hasMoreMessagesAbove: true
    })
  })
})

describe('applyMessageWindowTrim', () => {
  it('suspendHeadTrim 为真时超阈值也不裁剪', () => {
    const messages = makeMessages(MESSAGE_WINDOW_MAX_SIZE + 10)
    const index = buildMessageIndex(messages)
    const result = applyMessageWindowTrim(messages, index, true)

    expect(result.headTrimmed).toBe(false)
    expect(result.messages).toBe(messages)
    expect(result.index).toBe(index)
  })

  it('suspendHeadTrim 为假时走正常裁剪', () => {
    const messages = makeMessages(MESSAGE_WINDOW_MAX_SIZE + 10)
    const result = applyMessageWindowTrim(messages, buildMessageIndex(messages), false)

    expect(result.headTrimmed).toBe(true)
    expect(result.messages).toHaveLength(MESSAGE_WINDOW_MAX_SIZE)
  })
})
