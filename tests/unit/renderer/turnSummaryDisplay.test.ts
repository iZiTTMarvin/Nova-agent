/**
 * turnSummaryDisplay 文案格式化单测
 */
import { describe, expect, it } from 'vitest'
import {
  formatDurationMs,
  formatL1Header,
  formatL2DiffSuffix,
  formatL2Summary
} from '../../../src/renderer/features/chat/turnSummaryDisplay'

describe('formatDurationMs', () => {
  it('小于 60s 显示秒', () => {
    expect(formatDurationMs(37_000)).toBe('37s')
  })

  it('≥60s 显示分秒', () => {
    expect(formatDurationMs(97_000)).toBe('1m 37s')
  })
})

describe('formatL1Header', () => {
  it('live 显示 Working…', () => {
    expect(formatL1Header({ phase: 'live' })).toBe('Working…')
    expect(formatL1Header({ phase: 'live', elapsedMs: 5000 })).toBe('Working… 5s')
  })

  it('completed 有 duration 显示 Worked for', () => {
    expect(formatL1Header({ phase: 'completed', durationMs: 97_000 })).toBe('Worked for 1m 37s')
  })

  it('无时间戳降级 Worked', () => {
    expect(formatL1Header({ phase: 'completed' })).toBe('Worked')
  })

  it('interrupted 追加 Stopped', () => {
    expect(formatL1Header({ phase: 'completed', durationMs: 10_000, interrupted: true })).toBe(
      'Worked for 10s · Stopped'
    )
  })
})

describe('formatL2Summary', () => {
  it('零项省略 bash', () => {
    const text = formatL2Summary({
      editedFileCount: 4,
      exploredFileCount: 2,
      searchCount: 1,
      commandCount: 0,
      additions: null,
      deletions: null,
      diffStatsReady: false
    })
    expect(text).toBe('Edited 4 files, explored 2 files, 1 search')
    expect(text).not.toContain('command')
  })

  it('含 bash 时显示 ran N commands', () => {
    const text = formatL2Summary({
      editedFileCount: 0,
      exploredFileCount: 0,
      searchCount: 0,
      commandCount: 3,
      additions: null,
      deletions: null,
      diffStatsReady: false
    })
    expect(text).toBe('Ran 3 commands')
  })
})

describe('formatL2DiffSuffix', () => {
  it('未就绪时 +… -… 占位', () => {
    const r = formatL2DiffSuffix({
      editedFileCount: 1,
      exploredFileCount: 0,
      searchCount: 0,
      commandCount: 0,
      additions: null,
      deletions: null,
      diffStatsReady: false
    })
    expect(r.text).toBe('+… -…')
    expect(r.isPlaceholder).toBe(true)
  })

  it('就绪时精确 diff', () => {
    const r = formatL2DiffSuffix({
      editedFileCount: 1,
      exploredFileCount: 0,
      searchCount: 0,
      commandCount: 0,
      additions: 254,
      deletions: 16,
      diffStatsReady: true
    })
    expect(r.text).toBe('+254 -16')
    expect(r.isPlaceholder).toBe(false)
  })
})
