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

/** 折叠头标题：正在工作… / 已工作 X 分 X 秒；用户中断时以「已停止」为主状态 */
export function formatWorkedHeader(options: WorkedHeaderOptions): string {
  const { phase, durationMs, elapsedMs, interrupted } = options

  if (phase === 'live') {
    const elapsed = elapsedMs ?? durationMs
    if (elapsed !== undefined && elapsed > 0) {
      return `正在工作… ${formatDurationMs(elapsed)}`
    }
    return '正在工作…'
  }

  if (interrupted) {
    if (durationMs !== undefined && durationMs > 0) {
      return `已停止 · 工作了 ${formatDurationMs(durationMs)}`
    }
    return '已停止'
  }

  if (durationMs !== undefined && durationMs > 0) {
    return `已工作 ${formatDurationMs(durationMs)}`
  }

  return '已工作'
}
