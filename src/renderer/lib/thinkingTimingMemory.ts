/**
 * 思考耗时内存表：在 liveTurn 开/封边界记录，避免 React 合帧或终态对账 remount 后丢秒数。
 * 仅存活在渲染进程会话内，不持久化。
 */

interface ThinkingTimingEntry {
  startedAt: number
  endedAt?: number
}

const byKey = new Map<string, ThinkingTimingEntry>()
/** 每个 message 当前未结束的思考块 key */
const openKeyByMessage = new Map<string, string>()

export function thinkingTimingKey(messageId: string, blockIndex: number): string {
  return `${messageId}:${blockIndex}`
}

export function markThinkingStarted(
  messageId: string,
  blockIndex: number,
  now: number = Date.now()
): void {
  const key = thinkingTimingKey(messageId, blockIndex)
  if (!byKey.has(key)) {
    byKey.set(key, { startedAt: now })
  }
  openKeyByMessage.set(messageId, key)
}

/** 只封存指定思考块，不误伤同一消息里后一段正在计时的思考 */
export function markThinkingEnded(
  messageId: string,
  blockIndex: number,
  now: number = Date.now()
): number | null {
  const key = thinkingTimingKey(messageId, blockIndex)
  const entry = byKey.get(key)
  if (!entry) return null
  if (entry.endedAt === undefined) {
    entry.endedAt = Math.max(now, entry.startedAt)
  }
  if (openKeyByMessage.get(messageId) === key) {
    openKeyByMessage.delete(messageId)
  }
  return Math.max(0, entry.endedAt - entry.startedAt)
}

export function markThinkingEndedForMessage(
  messageId: string,
  now: number = Date.now()
): number | null {
  const key = openKeyByMessage.get(messageId)
  if (!key) return null
  const entry = byKey.get(key)
  if (!entry) {
    openKeyByMessage.delete(messageId)
    return null
  }
  if (entry.endedAt === undefined) {
    entry.endedAt = Math.max(now, entry.startedAt)
  }
  openKeyByMessage.delete(messageId)
  return Math.max(0, entry.endedAt - entry.startedAt)
}

/** 读取已记录耗时（秒）；无记录返回 null */
export function readThinkingElapsedSec(
  messageId: string,
  blockIndex: number,
  now: number = Date.now()
): number | null {
  const entry = byKey.get(thinkingTimingKey(messageId, blockIndex))
  if (!entry) return null
  const end = entry.endedAt ?? now
  return Math.max(0, (end - entry.startedAt) / 1000)
}

export function clearThinkingTimingForMessage(messageId: string): void {
  openKeyByMessage.delete(messageId)
  const prefix = `${messageId}:`
  for (const key of [...byKey.keys()]) {
    if (key.startsWith(prefix)) byKey.delete(key)
  }
}

/** 测试用：清空全部计时 */
export function resetThinkingTimingMemory(): void {
  byKey.clear()
  openKeyByMessage.clear()
}
