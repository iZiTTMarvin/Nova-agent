import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clearThinkingTimingForMessage,
  markThinkingEndedForMessage,
  markThinkingStarted,
  readThinkingElapsedSec,
  resetThinkingTimingMemory
} from '../../../src/renderer/lib/thinkingTimingMemory'

afterEach(() => {
  resetThinkingTimingMemory()
  vi.useRealTimers()
})

describe('thinkingTimingMemory', () => {
  it('记录开始与结束耗时，remount 后仍可读', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))

    markThinkingStarted('msg_1', 0)
    vi.setSystemTime(new Date('2026-01-01T00:00:02.400Z'))
    expect(markThinkingEndedForMessage('msg_1')).toBe(2400)

    expect(readThinkingElapsedSec('msg_1', 0)).toBeCloseTo(2.4, 5)
  })

  it('同一 key 不重复开工；结束无 open 时为 no-op', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    markThinkingStarted('msg_1', 0)
    vi.setSystemTime(new Date('2026-01-01T00:00:01.000Z'))
    markThinkingStarted('msg_1', 0)
    expect(markThinkingEndedForMessage('msg_1')).toBe(1000)
    expect(markThinkingEndedForMessage('msg_1')).toBeNull()

    expect(readThinkingElapsedSec('msg_1', 0)).toBeCloseTo(1, 5)
  })

  it('clearThinkingTimingForMessage 清除该消息全部条目', () => {
    markThinkingStarted('msg_1', 0)
    markThinkingStarted('msg_1', 2)
    clearThinkingTimingForMessage('msg_1')
    expect(readThinkingElapsedSec('msg_1', 0)).toBeNull()
    expect(readThinkingElapsedSec('msg_1', 2)).toBeNull()
  })
})
