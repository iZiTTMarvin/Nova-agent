/**
 * 消息列表尾部分层：仅最后 N 条消息保持 live 渲染，更早的消息走 static 减负。
 *
 * 借鉴 OpenCowork MessageList 的 TAIL_LIVE_MESSAGE_COUNT 策略：
 * static 消息关闭工具卡入场动画、打字机 / 思考计时器等流式副作用，
 * 降低长会话在 bash 流式期间的 DOM 参与面与合成层数量。
 */

/** 尾部保持 live 渲染的消息条数（含当前流式中的 assistant 消息） */
export const TAIL_LIVE_MESSAGE_COUNT = 6

export type MessageRenderMode = 'live' | 'static'

/**
 * 根据行下标与会话是否生成中，判定单条消息的渲染分层。
 *
 * - `live`：完整流式能力（工具卡入场、打字机、思考计时器等）
 * - `static`：纯静态展示，关闭上述副作用
 */
export function resolveMessageRenderMode(
  rowIndex: number,
  messageCount: number,
  _isSessionGenerating: boolean
): MessageRenderMode {
  if (messageCount <= 0) return 'live'
  const liveCutoff = Math.max(0, messageCount - TAIL_LIVE_MESSAGE_COUNT)
  return rowIndex < liveCutoff ? 'static' : 'live'
}
