/**
 * 可运行的 perf harness（不依赖完整 Electron E2E）
 *
 * 覆盖：
 * 1. 100k 字符增量 Markdown 拆分成本趋势（reparseChars 不随全文线性上升）
 * 2. 预算断言接口（commit 分位数 / longtask / heap）
 * 3. 500–2000 条消息 fixture 生成（供后续真实 Electron 回放）
 *
 * 完整 Electron + Playwright 回放可在此基础上扩展；当前 CI 先跑本 harness，
 * 保证门禁脚本与预算接口可用。
 *
 * 局限说明见 README.md（含 phase3Performance.test.ts 为何不能证明「真实不卡」）。
 */
import { describe, expect, it } from 'vitest'
import {
  assertPerfBudget,
  buildDeltaTrace,
  buildMessageHistoryFixture,
  computePercentiles,
  DEFAULT_PERF_BUDGET,
  type PerfSampleReport
} from './perfBudget'
import {
  estimateParseCostChars,
  splitIncrementalMarkdown
} from '../../src/renderer/features/chat/incrementalMarkdown'

describe('Electron perf harness（骨架）', () => {
  it('computePercentiles 正确计算 p50/p95/p99', () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1)
    const p = computePercentiles(values)
    expect(p.count).toBe(100)
    expect(p.p50).toBeGreaterThanOrEqual(50)
    expect(p.p95).toBeGreaterThanOrEqual(95)
    expect(p.p99).toBeGreaterThanOrEqual(99)
    expect(p.max).toBe(100)
  })

  it('100k delta trace：每步 reparseChars 有界（不随全文线性）', () => {
    const chunks = buildDeltaTrace(100_000, 128)
    let content = ''
    let sealedEnd = 0
    const reparseSamples: number[] = []

    for (const chunk of chunks) {
      content += chunk
      const split = splitIncrementalMarkdown(content, false, sealedEnd)
      sealedEnd = split.sealedEndOffset
      reparseSamples.push(estimateParseCostChars(split).reparseChars)
    }

    expect(content.length).toBeGreaterThanOrEqual(100_000)
    const late = reparseSamples.slice(Math.floor(reparseSamples.length / 2))
    const lateP95 = computePercentiles(late).p95
    // 后半段重解析成本应远小于全文（两阶段增量验收）
    expect(lateP95).toBeLessThan(25_000)
    expect(lateP95).toBeLessThan(content.length * 0.2)
  })

  it('assertPerfBudget：超预算时 ok=false 并列出失败项', () => {
    const report: PerfSampleReport = {
      label: 'synthetic-fail',
      commitMs: { p50: 10, p95: 100, p99: 200, max: 200, count: 50 },
      longTaskCount: 10,
      heapUsedStart: 1_000_000,
      heapUsedEnd: 5_000_000
    }
    const result = assertPerfBudget(report, {
      commitP95Ms: 50,
      commitP99Ms: 80,
      maxLongTasks: 3,
      maxHeapGrowthBytes: 1_000_000
    })
    expect(result.ok).toBe(false)
    expect(result.failures.length).toBeGreaterThanOrEqual(3)
  })

  it('assertPerfBudget：在预算内时 ok=true', () => {
    const report: PerfSampleReport = {
      label: 'synthetic-pass',
      commitMs: { p50: 5, p95: 20, p99: 30, max: 35, count: 40 },
      longTaskCount: 0
    }
    const result = assertPerfBudget(report, DEFAULT_PERF_BUDGET)
    expect(result.ok).toBe(true)
    expect(result.failures).toEqual([])
  })

  it('可生成 500/2000 条消息历史 fixture（虚拟列表压力场景）', () => {
    const mid = buildMessageHistoryFixture(500)
    const large = buildMessageHistoryFixture(2000)
    expect(mid).toHaveLength(500)
    expect(large).toHaveLength(2000)
    expect(large[0].id).toBe('perf_msg_0')
    expect(large[1999].role).toBe('assistant')
  })
})
