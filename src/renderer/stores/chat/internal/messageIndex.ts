import type { ExtendedMessage } from '../types'

/** 根据 messages 数组构建 id → index 索引，加速 delta handler O(1) 定位 */
export function buildMessageIndex(messages: ExtendedMessage[]): Record<string, number> {
  const index: Record<string, number> = {}
  for (let i = 0; i < messages.length; i++) {
    index[messages[i].id] = i
  }
  return index
}

/** 给消息 bump 一次 _revision，返回新引用。所有 store 内 mutate 路径都通过它，保证 revision 单调递增。 */
export function bumpRevision(msg: ExtendedMessage): ExtendedMessage {
  return { ...msg, _revision: (msg._revision ?? 0) + 1 }
}
