import type { ExtendedMessage, LiveBlock } from '../stores/types'

/**
 * 把一个活跃块合并进消息：末块同类型则合并（保 providerId 等附加字段），否则 push 新块；
 * 同时把文本/思考字节累加进 content / thinking。
 *
 * 单一真源：流式「投影视图」（活跃 MessageItem 渲染）与「折叠视图」（边界写回 messages）
 * 必须共用同一份合并逻辑，否则两套视图会在封存瞬间出现跳变。
 *
 * 不 bump _revision：折叠路径由调用方在组装完终态后统一 bump 一次；投影路径沿用原 msg
 * 的 _revision，重渲染由 liveTurn 订阅独立驱动。
 */
export function mergeLiveBlockIntoMessage(msg: ExtendedMessage, live: LiveBlock): ExtendedMessage {
  const blocks = msg.blocks ? [...msg.blocks] : []
  const last = blocks[blocks.length - 1]
  if (last && last.type === live.type) {
    blocks[blocks.length - 1] = { ...last, content: last.content + live.content }
  } else {
    blocks.push({ type: live.type, content: live.content })
  }
  return {
    ...msg,
    content: live.type === 'text' ? (msg.content ?? '') + live.content : msg.content,
    thinking: live.type === 'thinking' ? (msg.thinking ?? '') + live.content : msg.thinking ?? '',
    blocks
  }
}
