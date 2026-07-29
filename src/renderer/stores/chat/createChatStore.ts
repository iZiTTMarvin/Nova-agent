import { create } from 'zustand'
import type { StateCreator } from 'zustand'
import type {
  BranchSliceState,
  ChatState,
  MessageSliceState,
  RecoverySliceState,
  SendSliceState,
  SessionSliceState,
  StreamSliceState,
  TurnLifecycleSliceState
} from './types'
import {
  createBranchSlice,
  createMessageSlice,
  createRecoverySlice,
  createSendSlice,
  createSessionSlice,
  createStreamSlice,
  createTurnLifecycleSlice
} from './slices'

/**
 * 各领域 slice 之外的状态与 action 创建器。
 * Omit 在类型层阻止组装方重复声明各 slice 拥有的字段。
 */
export type ChatRestCreator = StateCreator<
  ChatState,
  [],
  [],
  Omit<
    ChatState,
    | keyof MessageSliceState
    | keyof StreamSliceState
    | keyof RecoverySliceState
    | keyof TurnLifecycleSliceState
    | keyof SessionSliceState
    | keyof SendSliceState
    | keyof BranchSliceState
  >
>

/** 唯一的 create<ChatState> 调用点：组装各 slice 与其余 Store 定义。 */
export function createChatStore(createRest: ChatRestCreator) {
  return create<ChatState>((set, get, api) => ({
    ...createMessageSlice(set, get, api),
    ...createStreamSlice(set, get, api),
    ...createRecoverySlice(set, get, api),
    ...createTurnLifecycleSlice(set, get, api),
    ...createSessionSlice(set, get, api),
    ...createSendSlice(set, get, api),
    ...createBranchSlice(set, get, api),
    ...createRest(set, get, api)
  }))
}
