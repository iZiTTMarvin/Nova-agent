import { create } from 'zustand'
import type { StateCreator } from 'zustand'
import type { ChatState, MessageSliceState, StreamSliceState } from './types'
import { createMessageSlice, createStreamSlice } from './slices'

/**
 * messageSlice 之外的状态与 action 创建器。
 * Omit 在类型层阻止组装方重复声明 messageSlice 拥有的字段。
 */
export type ChatRestCreator = StateCreator<
  ChatState,
  [],
  [],
  Omit<ChatState, keyof MessageSliceState | keyof StreamSliceState>
>

/** 唯一的 create<ChatState> 调用点：组装各 slice 与其余 Store 定义。 */
export function createChatStore(createRest: ChatRestCreator) {
  return create<ChatState>((set, get, api) => ({
    ...createMessageSlice(set, get, api),
    ...createStreamSlice(set, get, api),
    ...createRest(set, get, api)
  }))
}
