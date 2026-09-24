import { describe, expect, it } from 'vitest'
import { formatCompactRelativeTime } from '../../../src/renderer/lib/time'

describe('formatCompactRelativeTime 紧凑相对时间格式化', () => {
  const baseTime = 1726790000000

  it('不足 1 分钟（0秒、59秒）返回 刚刚', () => {
    expect(formatCompactRelativeTime(baseTime, baseTime)).toBe('刚刚')
    expect(formatCompactRelativeTime(baseTime - 30 * 1000, baseTime)).toBe('刚刚')
    expect(formatCompactRelativeTime(baseTime - 59 * 1000, baseTime)).toBe('刚刚')
  })

  it('1 分钟至 59 分钟返回 Nm', () => {
    expect(formatCompactRelativeTime(baseTime - 60 * 1000, baseTime)).toBe('1m')
    expect(formatCompactRelativeTime(baseTime - 35 * 60 * 1000, baseTime)).toBe('35m')
    expect(formatCompactRelativeTime(baseTime - 59 * 60 * 1000, baseTime)).toBe('59m')
  })

  it('1 小时至 23 小时返回 Nh', () => {
    expect(formatCompactRelativeTime(baseTime - 60 * 60 * 1000, baseTime)).toBe('1h')
    expect(formatCompactRelativeTime(baseTime - 3 * 3600 * 1000, baseTime)).toBe('3h')
    expect(formatCompactRelativeTime(baseTime - 23 * 3600 * 1000, baseTime)).toBe('23h')
  })

  it('24 小时以上返回 Nd', () => {
    expect(formatCompactRelativeTime(baseTime - 24 * 3600 * 1000, baseTime)).toBe('1d')
    expect(formatCompactRelativeTime(baseTime - 8 * 24 * 3600 * 1000, baseTime)).toBe('8d')
    expect(formatCompactRelativeTime(baseTime - 15 * 24 * 3600 * 1000, baseTime)).toBe('15d')
    expect(formatCompactRelativeTime(baseTime - 60 * 24 * 3600 * 1000, baseTime)).toBe('60d')
  })

  it('容错：未来时间戳返回 刚刚', () => {
    expect(formatCompactRelativeTime(baseTime + 5000, baseTime)).toBe('刚刚')
  })
})
