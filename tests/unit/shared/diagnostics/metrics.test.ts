/**
 * T0-4 metrics 单元测试：默认关闭、开启后可记录 attempt/TTFT/append/readState
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  isMetricsEnabled,
  recordMetric,
  metricAttemptStart,
  metricAttemptTtft,
  metricAttemptEnd,
  metricSessionAppend,
  metricReadStateStats,
  getMetricBuffer,
  resetMetricsForTests,
  registerMetricSink
} from '../../../../src/shared/diagnostics/metrics'

describe('T0-4 结构化指标埋点', () => {
  const prev = process.env.NOVA_METRICS

  beforeEach(() => {
    resetMetricsForTests()
    delete process.env.NOVA_METRICS
  })

  afterEach(() => {
    resetMetricsForTests()
    if (prev === undefined) delete process.env.NOVA_METRICS
    else process.env.NOVA_METRICS = prev
  })

  it('默认关闭时 recordMetric 为 no-op', () => {
    expect(isMetricsEnabled()).toBe(false)
    recordMetric('attempt.start', { count: 1 }, { id: 'a1' })
    expect(getMetricBuffer()).toHaveLength(0)
  })

  it('NOVA_METRICS=1 时记录 attempt / TTFT / append / readState', () => {
    process.env.NOVA_METRICS = '1'
    expect(isMetricsEnabled()).toBe(true)

    const seen: string[] = []
    registerMetricSink(e => seen.push(e.category))

    metricAttemptStart('att_1')
    metricAttemptTtft('att_1', 120)
    metricAttemptEnd('att_1', 500, 'ok')
    metricSessionAppend('sess_1', 3, 42)
    metricReadStateStats(10, 1_024_000, 2)

    expect(getMetricBuffer()).toHaveLength(5)
    expect(seen).toEqual([
      'attempt.start',
      'attempt.ttft',
      'attempt.end',
      'session.append',
      'readState.stats'
    ])

    const ttft = getMetricBuffer().find(e => e.category === 'attempt.ttft')
    expect(ttft?.values.ttftMs).toBe(120)
    expect(ttft?.id).toBe('att_1')

    const append = getMetricBuffer().find(e => e.category === 'session.append')
    expect(append?.values.durationMs).toBe(3)
    expect(append?.values.messageCount).toBe(42)

    const rs = getMetricBuffer().find(e => e.category === 'readState.stats')
    expect(rs?.values.entries).toBe(10)
    expect(rs?.values.bytes).toBe(1_024_000)
    expect(rs?.values.evictions).toBe(2)
  })
})
