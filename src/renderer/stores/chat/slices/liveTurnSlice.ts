import type { ChatSliceCreator, LiveTurnSliceState } from '../types'

/**
 * 活跃回合 slice：拥有流式期间未封存的尾部块（text / thinking）的初值与会话切换 reset。
 * 流式期间的累积与各边界（tool-call-start / message-end / error / 水合对账）的 fold+清空，
 * 由 streamSlice、turnLifecycleSlice、workspaceSyncSlice 与 focusedSessionReconcile 在各自
 * 单次 set 内写回；本 slice 不参与运行期写入，只定义瞬态字段的归属与生命周期。
 */
export function initialLiveTurnState(): Pick<LiveTurnSliceState, 'liveTurn'> {
  return { liveTurn: {} }
}

export function resetLiveTurnOnSessionSwitch(): Pick<LiveTurnSliceState, 'liveTurn'> {
  return initialLiveTurnState()
}

export const createLiveTurnSlice: ChatSliceCreator<LiveTurnSliceState> = () => ({
  ...initialLiveTurnState()
})
