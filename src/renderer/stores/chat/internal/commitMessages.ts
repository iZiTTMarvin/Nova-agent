import type { ChatState, ExtendedMessage } from '../types'
import { buildMessageIndex } from './messageIndex'
import { applyMessageWindowTrim, paginationPatchAfterHeadTrim } from './messageWindow'

export interface CommitMessagesInput {
  nextMessages: ExtendedMessage[]
  /** 已增量维护好的索引；未提供时由本函数重建 */
  nextIndex?: Record<string, number>
  /** 需要保留完整消息投影的分叉、水合等受控写入可跳过窗口裁剪 */
  skipWindowTrim?: boolean
}

/**
 * 生成 messages / messageIndexById / 分页游标的原子 patch，
 * 是消息列表三条不变量（索引一致、窗口上限、裁剪后游标同步）的唯一提交口。
 * 任何写 messages 的路径都必须经此生成 patch，再在调用方自己的单次 set() 里展开，
 * 因此不增加 set 次数。纯函数，不调 set，无副作用。
 */
export function commitMessageList(
  state: Pick<ChatState, 'suspendHeadTrim'>,
  input: CommitMessagesInput
): Partial<ChatState> {
  const index = input.nextIndex ?? buildMessageIndex(input.nextMessages)
  if (input.skipWindowTrim) {
    return { messages: input.nextMessages, messageIndexById: index }
  }
  const trimmed = applyMessageWindowTrim(input.nextMessages, index, state.suspendHeadTrim)
  return {
    messages: trimmed.messages,
    messageIndexById: trimmed.index,
    ...paginationPatchAfterHeadTrim(trimmed)
  }
}
