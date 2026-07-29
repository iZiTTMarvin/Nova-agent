import { MESSAGE_WINDOW_MAX_SIZE, MESSAGE_WINDOW_TAIL_PRESERVE } from '../constants'
import type { ChatState, ExtendedMessage } from '../types'

/** 消息窗口头部裁剪。超过上限时裁掉超出部分，使窗口回到最大容量。 */
export function trimMessageWindow(
  messages: ExtendedMessage[],
  index: Record<string, number>
): { messages: ExtendedMessage[]; index: Record<string, number>; headTrimmed: boolean } {
  if (messages.length <= MESSAGE_WINDOW_MAX_SIZE) {
    return { messages, index, headTrimmed: false }
  }
  const tailPreserve = messages.length - MESSAGE_WINDOW_TAIL_PRESERVE
  const trimCount = Math.min(messages.length - MESSAGE_WINDOW_MAX_SIZE, Math.max(0, tailPreserve))
  if (trimCount <= 0) return { messages, index, headTrimmed: false }
  const trimmed = messages.slice(trimCount)
  const newIndex: Record<string, number> = {}
  for (let i = 0; i < trimmed.length; i++) {
    newIndex[trimmed[i].id] = i
  }
  return { messages: trimmed, index: newIndex, headTrimmed: true }
}

/**
 * 头部裁剪后同步分页游标：被裁消息仍在盘上，可通过 loadOlderMessages 补回。
 */
export function paginationPatchAfterHeadTrim(
  trimResult: { messages: ExtendedMessage[]; headTrimmed: boolean }
): Pick<ChatState, 'oldestLoadedMessageId' | 'hasMoreMessagesAbove'> | Record<string, never> {
  if (!trimResult.headTrimmed) return {}
  return {
    oldestLoadedMessageId: trimResult.messages[0]?.id ?? null,
    hasMoreMessagesAbove: true
  }
}

/**
 * 在 suspendHeadTrim 时跳过头部裁剪（用户上滚补载后保留已 prepend 的早期历史）。
 */
export function applyMessageWindowTrim(
  messages: ExtendedMessage[],
  index: Record<string, number>,
  suspendHeadTrim: boolean
): { messages: ExtendedMessage[]; index: Record<string, number>; headTrimmed: boolean } {
  if (suspendHeadTrim) return { messages, index, headTrimmed: false }
  return trimMessageWindow(messages, index)
}
