import type { HookEvent } from '../../../../shared/agent/types'
import type { RendererRecoveryState } from '../../../../shared/ipc/types'
import type { ChatSliceCreator, RecoverySliceState } from '../types'

export function initialRecoveryState(): Pick<
  RecoverySliceState,
  'recoveryState' | 'hookErrors'
> {
  return { recoveryState: {}, hookErrors: {} }
}

/**
 * 恢复态簿记两字段的 owner。轮次终态的按 messageId 清理
 * 由 internal/recoveryFields.omitRecoveryFieldsForMessage 提供，
 * 其他 slice 不得直接改写这两个字段。
 */
export const createRecoverySlice: ChatSliceCreator<RecoverySliceState> = (set) => ({
  ...initialRecoveryState(),

  handleRecoveryState: (messageId: string, recovery: RendererRecoveryState) => {
    set(state => ({
      recoveryState: { ...state.recoveryState, [messageId]: recovery }
    }))
  },

  handleHookError: (messageId: string, hookEvent: HookEvent, error: string) => {
    set(state => ({
      hookErrors: {
        ...state.hookErrors,
        [messageId]: [...(state.hookErrors[messageId] ?? []), { hookEvent, error }]
      }
    }))
  }
})
