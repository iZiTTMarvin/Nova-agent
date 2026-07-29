import type { ChatState } from '../types'

/** 按 messageId 移除恢复 / Hook 相关临时状态（message-end 与 error 路径共用） */
export function omitRecoveryFieldsForMessage(
  state: Pick<ChatState, 'recoveryState' | 'recoveryHints' | 'hookErrors'>,
  messageId: string
): Pick<ChatState, 'recoveryState' | 'recoveryHints' | 'hookErrors'> {
  const { [messageId]: _rs, ...restRecoveryState } = state.recoveryState
  const { [messageId]: _rh, ...restRecoveryHints } = state.recoveryHints
  const { [messageId]: _he, ...restHookErrors } = state.hookErrors
  return {
    recoveryState: restRecoveryState,
    recoveryHints: restRecoveryHints,
    hookErrors: restHookErrors
  }
}
