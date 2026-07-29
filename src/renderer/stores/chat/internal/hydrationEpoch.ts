/**
 * 会话水合 generation fence 的唯一 owner。
 * 切会话与测试重置都会使旧水合失效：晚到的 load-session 结果
 * 凭 epoch 比对判定过期，不得覆盖新会话的消息。
 */
let focusedSessionHydrationEpoch = 0

/** 开启一轮新的水合，返回本轮 epoch（旧轮次随之失效） */
export function nextHydrationEpoch(): number {
  return ++focusedSessionHydrationEpoch
}

/** 判断给定 epoch 是否仍是当前轮次 */
export function isHydrationEpochCurrent(epoch: number): boolean {
  return epoch === focusedSessionHydrationEpoch
}

/** 使当前所有在途水合失效（测试重置用） */
export function invalidateHydrationEpoch(): void {
  focusedSessionHydrationEpoch++
}
