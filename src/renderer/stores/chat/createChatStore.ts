import { create } from 'zustand'
import type { StateCreator } from 'zustand'
import type { ChatState, MessageSliceState } from './types'
import { createMessageSlice } from './slices'

/**
 * messageSlice 之外的状态与 action 创建器。
 * Omit 在类型层阻止组装方重复声明 messageSlice 拥有的字段。
 */
export type ChatRestCreator = StateCreator<
  ChatState,
  [],
  [],
  Omit<ChatState, keyof MessageSliceState>
>

/** 唯一的 create<ChatState> 调用点：组装 messageSlice 与其余 Store 定义。 */
export function createChatStore(createRest: ChatRestCreator) {
  return create<ChatState>((set, get, api) => ({
    ...createMessageSlice(set, get, api),
    ...createRest(set, get, api)
  }))
}
