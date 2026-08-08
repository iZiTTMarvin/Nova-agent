/**
 * 会话入口锁的决策。
 *
 * 同一会话同时只允许一个 turn。turn 已被占用时，新消息进入 steering queue，
 * 当前 turn 终态后再发起。
 */

export type EntryLockAction =
  /** 入口空闲，继续本 turn */
  | { kind: 'proceed' }
  /** 进 steering queue，当前 turn 终态后自动发起 */
  | { kind: 'steer' }

export interface EntryLockInput {
  /** 该会话是否已有占用 turn 的 run */
  turnInProgress: boolean
}

export function resolveEntryLockAction(input: EntryLockInput): EntryLockAction {
  if (!input.turnInProgress) return { kind: 'proceed' }
  return { kind: 'steer' }
}
