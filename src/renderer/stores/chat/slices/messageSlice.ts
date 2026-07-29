import type { ChatSliceCreator, MessageSliceState } from '../types'

/** messages / messageIndexById 的初始状态。字段变更时 slice 自身即真源。 */
export function initialMessageState(): MessageSliceState {
  return { messages: [], messageIndexById: {} }
}

/**
 * 切会话时清空旧会话的消息投影。目标会话消息由 snapshot-first 水合重新装载，
 * 禁止从可能陈旧的 renderer 缓存猜测。
 */
export function resetMessageOnSessionSwitch(): MessageSliceState {
  return { messages: [], messageIndexById: {} }
}

/**
 * messages / messageIndexById 两个字段的声明 owner 与 initial state 提供者。
 * 不含 action：消息变更由具体业务 slice 触发，且必须经 internal/commitMessages 生成 patch。
 */
export const createMessageSlice: ChatSliceCreator<MessageSliceState> = () => initialMessageState()
