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
}

/** 停止与完成共用「已工作」标题；停止是用户意图，不单独宣告。 */
export function formatWorkedHeader(options: WorkedHeaderOptions): string {
  const { phase, durationMs, elapsedMs } = options

  if (phase === 'live') {
    const elapsed = elapsedMs ?? durationMs
    if (elapsed !== undefined && elapsed >= 0) {
      return `工作中 ${formatDurationMs(elapsed)}`
    }
    return '工作中'
  }

  if (durationMs !== undefined && durationMs >= 0) {
    return `已工作 ${formatDurationMs(durationMs)}`
  }

  return '已工作'
}

/** completed 轮次无最终 text 时的占位文案；仅渲染层使用，不写入消息历史 */
export const MISSING_ANSWER_TEXT = '已结束，未生成总结'
