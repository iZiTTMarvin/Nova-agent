/**
 * 工作区折叠头文案格式化
 */

/** 将毫秒格式化为时长：37 秒 / 1 分 37 秒 */
export function formatDurationMs(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000))
  if (totalSec < 60) return `${totalSec} 秒`
  const min = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  return sec > 0 ? `${min} 分 ${sec} 秒` : `${min} 分`
}

export interface WorkedHeaderOptions {
  phase: 'live' | 'completed'
  durationMs?: number
  elapsedMs?: number
  interrupted?: boolean
}

/** 折叠头标题：正在工作… / 已工作 X 分 X 秒（无时间戳时降级「已工作」） */
export function formatWorkedHeader(options: WorkedHeaderOptions): string {
  const { phase, durationMs, elapsedMs, interrupted } = options

  if (phase === 'live') {
    const elapsed = elapsedMs ?? durationMs
    if (elapsed !== undefined && elapsed > 0) {
      return `正在工作… ${formatDurationMs(elapsed)}`
    }
    return '正在工作…'
  }

  if (durationMs !== undefined && durationMs > 0) {
    const base = `已工作 ${formatDurationMs(durationMs)}`
    return interrupted ? `${base} · 已停止` : base
  }

  return interrupted ? '已工作 · 已停止' : '已工作'
}
