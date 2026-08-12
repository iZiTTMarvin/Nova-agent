import { useMemo } from 'react'
import { useChatStore } from '../../stores/useChatStore'
import type { ExtendedMessage } from '../../stores/types'
import { mergeLiveBlockIntoMessage as projectLiveMessage } from '../../lib/liveBlockMerge'
// 投影与折叠共用同一份合并逻辑（真源在 lib/liveBlockMerge），流式视图与封存后视图不出现跳变。
export { projectLiveMessage }

/**
 * 把活跃回合（liveTurn）的未封存尾部块叠加到消息，供流式中的尾部 MessageItem 渲染。
 *
 * 非活跃消息（无 liveTurn 条目）选择器返回 undefined → 原样返回 msg，零额外开销、
 * 不触发重渲染。活跃消息随 liveTurn 变化由 zustand hook 独立驱动重渲染，绕开
 * ChatPanel 的 messages 订阅 —— 这是流式期间顶层不再每帧提交的关键。
 */
export function useEffectiveMessage(msg: ExtendedMessage): ExtendedMessage {
  const live = useChatStore(state => state.liveTurn[msg.id])
  return useMemo(() => (live ? projectLiveMessage(msg, live) : msg), [msg, live])
}
