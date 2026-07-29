import type { StreamSliceState } from '../types'

/**
 * 流式瞬态字段的空状态。会话切换与轮次中断（cancel / interrupted message-end）
 * 都要求完整丢弃流式工具参数累积，此处是该字段集合的唯一定义点。
 */
export function emptyStreamTransientState(): Pick<StreamSliceState, 'streamingToolArgs'> {
  return { streamingToolArgs: {} }
}
