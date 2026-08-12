import type { ExtendedMessage, LiveBlock } from '../types'
import { mergeLiveBlockIntoMessage as appendLiveBlock } from '../../../lib/liveBlockMerge'

// 折叠路径与渲染投影路径共用同一份合并逻辑（真源在 lib/liveBlockMerge），避免两套视图在封存瞬间跳变。
export { appendLiveBlock }

/** 返回移除指定 messageId 活跃块后的 liveTurn（不可变）。无对应键时返回原引用。 */
export function removeLiveTurnEntry(
  liveTurn: Record<string, LiveBlock>,
  messageId: string
): Record<string, LiveBlock> {
  if (!(messageId in liveTurn)) return liveTurn
  const next = { ...liveTurn }
  delete next[messageId]
  return next
}

/**
 * 把所有活跃块 fold 进对应消息，返回新数组 + 是否发生过 fold。
 * 用于对账/水合前的预处理：让 merge 能看到实时内容，避免空壳被旧持久化/草稿覆盖。
 * 调用方负责在写回时把 liveTurn 清空（hasLive=true 时）。
 */
export function foldLiveTurnIntoMessages(
  messages: ExtendedMessage[],
  liveTurn: Record<string, LiveBlock>
): { messages: ExtendedMessage[]; hasLive: boolean } {
  const ids = Object.keys(liveTurn)
  if (ids.length === 0) return { messages, hasLive: false }
  return {
    messages: messages.map(m => {
      const live = liveTurn[m.id]
      return live ? appendLiveBlock(m, live) : m
    }),
    hasLive: true
  }
}

