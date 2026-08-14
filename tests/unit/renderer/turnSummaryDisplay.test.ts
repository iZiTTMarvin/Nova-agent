/**
 * turnSummaryDisplay 文案格式化单测
 */
import { describe, expect, it } from 'vitest'
import {
  formatDurationMs,
  formatWorkedHeader
} from '../../../src/renderer/features/chat/turnSummaryDisplay'

describe('formatDurationMs', () => {
  it('小于 60s 显示秒', () => {
    expect(formatDurationMs(37_000)).toBe('37 秒')
  })

  it('≥60s 显示分秒', () => {
    expect(formatDurationMs(97_000)).toBe('1 分 37 秒')
  })

  it('整分钟不显示零秒', () => {
    expect(formatDurationMs(120_000)).toBe('2 分')
  })
})

describe('formatWorkedHeader', () => {
  it('live 显示正在工作…', () => {
    expect(formatWorkedHeader({ phase: 'live' })).toBe('正在工作…')
    expect(formatWorkedHeader({ phase: 'live', elapsedMs: 5000 })).toBe('正在工作… 5 秒')
  })

  it('completed 有 duration 显示已工作', () => {
    expect(formatWorkedHeader({ phase: 'completed', durationMs: 97_000 })).toBe('已工作 1 分 37 秒')
  })

  it('无时间戳降级已工作', () => {
    expect(formatWorkedHeader({ phase: 'completed' })).toBe('已工作')
  })

  it('interrupted 以已停止为主状态', () => {
    expect(formatWorkedHeader({ phase: 'completed', durationMs: 10_000, interrupted: true })).toBe(
      '已停止 · 工作了 10 秒'
    )
    expect(formatWorkedHeader({ phase: 'completed', interrupted: true })).toBe('已停止')
  })
})
