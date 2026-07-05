/**
 * TurnProcessTree L1/L2 文案格式化
 */
import type { TurnSummary } from './turnProcessModel'

/** 将毫秒格式化为 Cursor 风时长：37s / 1m 37s */
export function formatDurationMs(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000))
  if (totalSec < 60) return `${totalSec}s`
  const min = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  return sec > 0 ? `${min}m ${sec}s` : `${min}m`
}

export interface L1HeaderOptions {
  phase: 'live' | 'completed'
  durationMs?: number
  elapsedMs?: number
  interrupted?: boolean
}

/** L1 标题：Working… / Worked for / Worked（无时间戳降级） */
export function formatL1Header(options: L1HeaderOptions): string {
  const { phase, durationMs, elapsedMs, interrupted } = options

  if (phase === 'live') {
    const elapsed = elapsedMs ?? durationMs
    if (elapsed !== undefined && elapsed > 0) {
      return `Working… ${formatDurationMs(elapsed)}`
    }
    return 'Working…'
  }

  if (durationMs !== undefined && durationMs > 0) {
    const base = `Worked for ${formatDurationMs(durationMs)}`
    return interrupted ? `${base} · Stopped` : base
  }

  return interrupted ? 'Worked · Stopped' : 'Worked'
}

/** L2 英文摘要：零项省略，与 Cursor 对齐 */
export function formatL2Summary(summary: TurnSummary): string {
  const parts: string[] = []

  if (summary.editedFileCount > 0) {
    parts.push(`Edited ${summary.editedFileCount} file${summary.editedFileCount === 1 ? '' : 's'}`)
  }
  if (summary.exploredFileCount > 0) {
    parts.push(`explored ${summary.exploredFileCount} file${summary.exploredFileCount === 1 ? '' : 's'}`)
  }
  if (summary.searchCount > 0) {
    parts.push(`${summary.searchCount} search${summary.searchCount === 1 ? '' : 'es'}`)
  }
  if (summary.commandCount > 0) {
    parts.push(`ran ${summary.commandCount} command${summary.commandCount === 1 ? '' : 's'}`)
  }

  if (parts.length === 0) {
    return 'Processed tools'
  }

  // 首段首字母大写，后续小写连接
  const text = parts.join(', ')
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** L2 diff 后缀：就绪时精确值，否则 +… -… 占位 */
export function formatL2DiffSuffix(summary: TurnSummary): { text: string; isPlaceholder: boolean } {
  if (summary.diffStatsReady && summary.additions !== null && summary.deletions !== null) {
    return {
      text: `+${summary.additions} -${summary.deletions}`,
      isPlaceholder: false
    }
  }
  return { text: '+… -…', isPlaceholder: true }
}
