/**
 * metrics 单元测试：默认关闭、开启后可记录 attempt/TTFT/append/readState
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
import { initLaunchIdentity, resetLaunchIdentityForTests } from '../../../../src/shared/diagnostics/launchIdentity'

describe('结构化指标埋点', () => {
  const prev = process.env.NOVA_METRICS

  beforeEach(() => {
    resetMetricsForTests()
    delete process.env.NOVA_METRICS
  })

  afterEach(() => {
    resetLaunchIdentityForTests()
    resetMetricsForTests()
    if (prev === undefined) delete process.env.NOVA_METRICS
    else process.env.NOVA_METRICS = prev
  })

  it('同一启动的构建身份保持固定，并随每条指标传给既有 sink', () => {
    resetLaunchIdentityForTests()
    const launch = initLaunchIdentity({ appVersion: 'fixture-version', buildFingerprint: 'fixture-build', host: 'node' })
    expect(initLaunchIdentity({ buildFingerprint: 'other-build' })).toBe(launch)
    process.env.NOVA_METRICS = '1'
    const stored: string[] = []
    registerMetricSink(event => stored.push(JSON.stringify(event)))
    recordMetric('attempt.start', { count: 1 })
    expect(JSON.parse(stored[0])).toMatchObject({ launchId: launch.launchId, buildFingerprint: 'fixture-build', appVersion: 'fixture-version' })
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
