/**
 * P1-C 缓存回归：L2 尾部记忆消息带 skipCacheMarker，不参与断点选择，
 * 稳定消息的 cache_control 位置与无 L2 基线逐字节一致。
 */
import { describe, it, expect } from 'vitest'
import { applyCacheMarkers } from '../../../../src/runtime/model/messageFormat'

/** 判断 API 消息是否被注入了 cache_control */
function hasCacheControl(msg: Record<string, unknown>): boolean {
  const content = msg.content
  if (typeof content === 'string') {
    return false
  }
  if (Array.isArray(content)) {
    return content.some(
      (block) =>
        typeof block === 'object' &&
        block !== null &&
        'cache_control' in (block as Record<string, unknown>)
    )
  }
  return false
}

/** 收集带 cache_control 的消息下标 */
function cacheMarkerIndices(messages: Record<string, unknown>[]): number[] {
  return messages
    .map((msg, idx) => (hasCacheControl(msg) ? idx : -1))
    .filter((idx) => idx >= 0)
}

describe('applyCacheMarkers — L2 skipCacheMarker 隔离（P1-C）', () => {
  const history = [
    { role: 'user', content: 'msg1' },
    { role: 'assistant', content: 'msg2' }
  ]

  /** 无 L2 基线：system + history + 当前 user */
  const baselineMessages = [
    { role: 'system', content: 'system prompt' },
    ...history,
    { role: 'user', content: 'current question' }
  ]

  /** 有 L2：尾部多一条 skipCacheMarker user */
  const withL2Messages = [
    ...baselineMessages,
    {
      role: 'user',
      content: '=== Relevant Memory ===\nQuery: auth\n[MEMORY.md]\nJWT 24h',
      skipCacheMarker: true
    }
  ]

  it('L2 消息不带 cache_control，断点落在 user(current) 与稳定 assistant', () => {
    const result = applyCacheMarkers(withL2Messages, 'cache_control')

    expect(result).toHaveLength(5)

    // system 带 cache_control
    expect(hasCacheControl(result[0])).toBe(true)

    // 稳定历史不被标记（倒数第 3 条非 system）
    expect(hasCacheControl(result[1])).toBe(false)

    // assistant（倒数第 2 条非 system、非 skipCacheMarker）带 cache_control
    expect(hasCacheControl(result[2])).toBe(true)

    // user(current)（倒数第 1 条可选断点）带 cache_control
    expect(hasCacheControl(result[3])).toBe(true)

    // L2 尾部：仍发送，但不参与断点选择
    expect(hasCacheControl(result[4])).toBe(false)
    expect(result[4].content).toBe(withL2Messages[4].content)
  })

  it('有 L2 时稳定消息断点位置与无 L2 基线一致', () => {
    const baselineMarked = applyCacheMarkers(baselineMessages, 'cache_control')
    const withL2Marked = applyCacheMarkers(withL2Messages, 'cache_control')

    const baselineIndices = cacheMarkerIndices(baselineMarked)
    const withL2Indices = cacheMarkerIndices(withL2Marked)

    // 两者应落在相同下标：system(0) + assistant(2) + user(current)(3)
    expect(withL2Indices).toEqual(baselineIndices)
    expect(baselineIndices).toEqual([0, 2, 3])
  })
})
