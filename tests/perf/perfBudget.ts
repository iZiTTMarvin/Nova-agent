/**
 * Electron / Chromium 性能门禁 — 预算断言接口与 harness 核心
 *
 * 设计目标：
 * - 可在真实 Electron Renderer 或 headless Chromium 中回放 delta / 消息历史
 * - 采集 commit p50/p95/p99、longtask、heap 趋势
 * - CI 通过 `npm run test:perf` 调用；预算失败时非零退出
 *
 * 与 phase3Performance.test.ts 的区别见同目录 README.md。
 */

export interface PerfPercentiles {
  p50: number
  p95: number
  p99: number
  max: number
  count: number
}

export interface PerfBudget {
  /** React commit / 自定义采样的 p95 上限（ms） */
  commitP95Ms: number
  /** React commit / 自定义采样的 p99 上限（ms） */
  commitP99Ms: number
  /** longtask 次数上限（PerformanceObserver） */
  maxLongTasks: number
  /** 采样期间 heap 增长上限（字节）；undefined 表示不检查 */
  maxHeapGrowthBytes?: number
}

export interface PerfSampleReport {
  label: string
  commitMs: PerfPercentiles
  longTaskCount: number
  heapUsedStart?: number
  heapUsedEnd?: number
  /** 额外诊断字段（如 mounted DOM 节点数、reparseChars） */
  extras?: Record<string, number | string | boolean>
}

export interface PerfBudgetResult {
  ok: boolean
  failures: string[]
  report: PerfSampleReport
}

/** 计算分位数；空数组返回全 0 */
export function computePercentiles(values: number[]): PerfPercentiles {
  if (values.length === 0) {
    return { p50: 0, p95: 0, p99: 0, max: 0, count: 0 }
  }
  const sorted = [...values].sort((a, b) => a - b)
  const at = (p: number): number => {
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))
    return sorted[idx]
  }
  return {
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: sorted[sorted.length - 1],
    count: sorted.length
  }
}

/** 默认预算：CI 可覆盖环境变量覆盖 */
export const DEFAULT_PERF_BUDGET: PerfBudget = {
  commitP95Ms: Number(process.env.NOVA_PERF_COMMIT_P95_MS ?? 50),
  commitP99Ms: Number(process.env.NOVA_PERF_COMMIT_P99_MS ?? 80),
  maxLongTasks: Number(process.env.NOVA_PERF_MAX_LONGTASKS ?? 5),
  maxHeapGrowthBytes: process.env.NOVA_PERF_MAX_HEAP_GROWTH_BYTES
    ? Number(process.env.NOVA_PERF_MAX_HEAP_GROWTH_BYTES)
    : undefined
}

/**
 * 对照预算断言。返回结构化结果，供 harness / CI 脚本打印与 exit code。
 */
export function assertPerfBudget(
  report: PerfSampleReport,
  budget: PerfBudget = DEFAULT_PERF_BUDGET
): PerfBudgetResult {
  const failures: string[] = []

  if (report.commitMs.count === 0) {
    failures.push('无 commit 采样，无法判定预算')
  } else {
    if (report.commitMs.p95 > budget.commitP95Ms) {
      failures.push(
        `commit p95=${report.commitMs.p95.toFixed(2)}ms > 预算 ${budget.commitP95Ms}ms`
      )
    }
    if (report.commitMs.p99 > budget.commitP99Ms) {
      failures.push(
        `commit p99=${report.commitMs.p99.toFixed(2)}ms > 预算 ${budget.commitP99Ms}ms`
      )
    }
  }

  if (report.longTaskCount > budget.maxLongTasks) {
    failures.push(
      `longtask 次数=${report.longTaskCount} > 预算 ${budget.maxLongTasks}`
    )
  }

  if (
    budget.maxHeapGrowthBytes != null
    && report.heapUsedStart != null
    && report.heapUsedEnd != null
  ) {
    const growth = report.heapUsedEnd - report.heapUsedStart
    if (growth > budget.maxHeapGrowthBytes) {
      failures.push(
        `heap 增长=${growth}B > 预算 ${budget.maxHeapGrowthBytes}B`
      )
    }
  }

  return { ok: failures.length === 0, failures, report }
}

/**
 * 合成 10k/100k 字符 delta trace：按 chunk 切分，供 harness 回放。
 * 保证拼接后总长度精确等于 totalChars。
 */
export function buildDeltaTrace(totalChars: number, chunkSize = 64): string[] {
  const chunks: string[] = []
  let remaining = totalChars
  let i = 0
  while (remaining > 0) {
    const n = Math.min(chunkSize, remaining)
    let piece: string
    if (i > 0 && i % 8 === 0 && n >= 8) {
      const prefix = `\n\n段落${i} `
      piece = prefix + 'x'.repeat(Math.max(0, n - prefix.length))
    } else {
      piece = 'x'.repeat(n)
    }
    // 截断/补齐到精确 n，避免前缀导致总长偏差
    if (piece.length > n) piece = piece.slice(0, n)
    else if (piece.length < n) piece = piece + 'x'.repeat(n - piece.length)
    chunks.push(piece)
    remaining -= n
    i += 1
  }
  return chunks
}

/**
 * 合成 N 条消息历史（交替 user/assistant），供虚拟列表压力场景。
 */
export function buildMessageHistoryFixture(count: number): Array<{
  id: string
  role: 'user' | 'assistant'
  content: string
}> {
  return Array.from({ length: count }, (_, index) => ({
    id: `perf_msg_${index}`,
    role: (index % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    content: `历史消息 ${index} — ${'内容'.repeat(8)}`
  }))
}
