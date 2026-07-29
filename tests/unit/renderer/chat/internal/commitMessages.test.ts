import { describe, expect, it } from 'vitest'
import { MESSAGE_WINDOW_MAX_SIZE } from '../../../../../src/renderer/stores/chat/constants'
import { buildMessageIndex, commitMessageList } from '../../../../../src/renderer/stores/chat/internal'
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

describe('commitMessageList', () => {
  it('不传 nextIndex 时重建索引，且索引与消息一致', () => {
    const messages = makeMessages(3)
    const patch = commitMessageList({ suspendHeadTrim: false }, { nextMessages: messages })

    expect(patch.messages).toBe(messages)
    expect(patch.messageIndexById).toEqual({ 'msg-0': 0, 'msg-1': 1, 'msg-2': 2 })
  })

  it('传 nextIndex 且未触发裁剪时不重建，原索引引用透传', () => {
    const messages = makeMessages(3)
    const index = buildMessageIndex(messages)
    const patch = commitMessageList(
      { suspendHeadTrim: false },
      { nextMessages: messages, nextIndex: index }
    )

    expect(patch.messages).toBe(messages)
    expect(patch.messageIndexById).toBe(index)
  })

  it('skipWindowTrim 为真时超阈值也不裁剪，且不产出分页字段', () => {
    const messages = makeMessages(MESSAGE_WINDOW_MAX_SIZE + 10)
    const patch = commitMessageList(
      { suspendHeadTrim: false },
      { nextMessages: messages, skipWindowTrim: true }
    )

    expect(patch.messages).toBe(messages)
    expect(Object.keys(patch)).toEqual(['messages', 'messageIndexById'])
  })

  it('超阈值 + 未 suspend 时产出裁剪后的 messages 与同步的分页游标', () => {
    const messages = makeMessages(MESSAGE_WINDOW_MAX_SIZE + 1)
    const patch = commitMessageList(
      { suspendHeadTrim: false },
      { nextMessages: messages, nextIndex: buildMessageIndex(messages) }
    )

    expect(patch.messages).toHaveLength(MESSAGE_WINDOW_MAX_SIZE)
    expect(patch.messages?.[0].id).toBe('msg-1')
    expect(patch.oldestLoadedMessageId).toBe('msg-1')
    expect(patch.hasMoreMessagesAbove).toBe(true)
    expect(patch.messageIndexById?.['msg-1']).toBe(0)
    expect(Object.keys(patch.messageIndexById ?? {})).toHaveLength(MESSAGE_WINDOW_MAX_SIZE)
  })

  it('suspendHeadTrim 为真时不裁剪，原引用透传且无分页字段', () => {
    const messages = makeMessages(MESSAGE_WINDOW_MAX_SIZE + 10)
    const index = buildMessageIndex(messages)
    const patch = commitMessageList(
      { suspendHeadTrim: true },
      { nextMessages: messages, nextIndex: index }
    )

    expect(patch.messages).toBe(messages)
    expect(patch.messageIndexById).toBe(index)
    expect(Object.keys(patch)).toEqual(['messages', 'messageIndexById'])
  })
})
