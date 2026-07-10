/**
 * T5-2 ReadStateCache 字节预算
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  createReadState,
  READ_STATE_DEFAULT_BUDGET_BYTES
} from '../../../../src/runtime/tools/editTool'
import {
  resetMetricsForTests,
  getMetricBuffer,
  metricReadStateStats
} from '../../../../src/shared/diagnostics/metrics'

describe('T5-2 ReadStateCache 字节预算', () => {
  const prev = process.env.NOVA_METRICS

  beforeEach(() => {
    resetMetricsForTests()
    process.env.NOVA_METRICS = '1'
  })

  afterEach(() => {
    resetMetricsForTests()
    if (prev === undefined) delete process.env.NOVA_METRICS
    else process.env.NOVA_METRICS = prev
  })

  it('总字节不超过配置预算，淘汰后 get 返回 undefined（要求重新 read）', () => {
    const budgetBytes = 200 // 很小，便于触发淘汰
    const rs = createReadState({ budgetBytes, maxEntryBytes: 1000 })

    // 每条 content 长度 60 → UTF-16 近似 120 字节
    rs.set('/a.ts', { content: 'a'.repeat(60), timestamp: 1 })
    rs.set('/b.ts', { content: 'b'.repeat(60), timestamp: 2 })
    rs.set('/c.ts', { content: 'c'.repeat(60), timestamp: 3 })

    const stats = rs.getStats()
    expect(stats.bytes).toBeLessThanOrEqual(budgetBytes)
    expect(stats.evictions).toBeGreaterThan(0)

    // 最早的应被淘汰
    expect(rs.get('/a.ts')).toBeUndefined()
    // 最近的仍在
    expect(rs.get('/c.ts')?.content).toBe('c'.repeat(60))
  })

  it('单文件超上限时不保留 content', () => {
    const rs = createReadState({ budgetBytes: 10_000_000, maxEntryBytes: 100 })
    rs.set('/big.ts', { content: 'x'.repeat(200), timestamp: 1, size: 200 })
    expect(rs.has('/big.ts')).toBe(false)
    expect(rs.get('/big.ts')).toBeUndefined()
  })

  it('getStats 暴露 entries/bytes/evictions/hitRate', () => {
    const rs = createReadState({ budgetBytes: READ_STATE_DEFAULT_BUDGET_BYTES })
    rs.set('/f.ts', { content: 'hello', timestamp: 1 })
    expect(rs.get('/f.ts')?.content).toBe('hello')
    expect(rs.get('/missing.ts')).toBeUndefined()

    const s = rs.getStats()
    expect(s.entries).toBe(1)
    expect(s.bytes).toBe(10) // 'hello'.length * 2
    expect(s.hits).toBe(1)
    expect(s.misses).toBe(1)
    expect(s.hitRate).toBe(0.5)
  })

  it('clear 释放全部条目并上报 metrics', () => {
    const rs = createReadState()
    rs.set('/f.ts', { content: 'hello', timestamp: 1 })
    rs.clear()
    expect(rs.getStats().entries).toBe(0)
    expect(rs.getStats().bytes).toBe(0)

    const events = getMetricBuffer().filter(e => e.category === 'readState.stats')
    expect(events.length).toBeGreaterThan(0)
    expect(events.at(-1)?.values.entries).toBe(0)
  })

  it('clone 隔离父子缓存', () => {
    const parent = createReadState({ budgetBytes: 10_000 })
    parent.set('/p.ts', { content: 'parent', timestamp: 1 })
    const child = parent.clone()
    child.set('/c.ts', { content: 'child', timestamp: 2 })
    expect(parent.get('/c.ts')).toBeUndefined()
    expect(child.get('/p.ts')?.content).toBe('parent')
  })

  it('metricReadStateStats 可记录 evictions', () => {
    metricReadStateStats(2, 100, 3)
    const ev = getMetricBuffer().find(e => e.category === 'readState.stats')
    expect(ev?.values.evictions).toBe(3)
  })
})
