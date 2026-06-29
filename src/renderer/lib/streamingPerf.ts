/**
 * streamingPerf — 流式渲染阶段的轻量性能采样（仅开发环境）
 *
 * 借鉴 OpenCowork streaming-perf.ts，适配 nova-agent：
 * - React.Profiler 记录的 commit 耗时（reactCommit）
 * - PerformanceObserver longtask（longTask）
 * - 可选 rAF 间隔采样（rafGap）
 *
 * 使用方式（DevTools Console）：
 *   window.__novaStreamingPerf?.snapshot()
 *   window.__novaStreamingPerf?.reset()
 */

type SampleBucket = 'reactCommit' | 'rafGap' | 'longTask'

interface DurationSample {
  durationMs: number
  at: number
  detail?: Record<string, unknown>
}

export interface StreamingPerfSnapshot {
  enabled: boolean
  samples: Record<SampleBucket, DurationSample[]>
  summary: Record<SampleBucket, { count: number; p95Ms: number; maxMs: number }>
  failures: string[]
}

export interface StreamingPerfApi {
  snapshot: () => StreamingPerfSnapshot
  reset: () => void
}

const MAX_SAMPLES = 800
const LONG_TASK_LIMIT_MS = 50
const REACT_COMMIT_P95_LIMIT_MS = 50
const REACT_COMMIT_MAX_LIMIT_MS = 120
const RAF_P95_LIMIT_MS = 25
const RAF_MAX_LIMIT_MS = 80

/** 仅在开发构建启用，避免生产包携带监控开销 */
const enabled =
  typeof import.meta !== 'undefined' &&
  Boolean((import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV)

const samples: Record<SampleBucket, DurationSample[]> = {
  reactCommit: [],
  rafGap: [],
  longTask: []
}

let installed = false
let rafId: number | null = null
let longTaskObserver: PerformanceObserver | null = null

function pushSample(
  bucket: SampleBucket,
  durationMs: number,
  detail?: Record<string, unknown>
): void {
  if (!enabled || !Number.isFinite(durationMs)) return
  const list = samples[bucket]
  list.push({
    durationMs,
    at: Date.now(),
    ...(detail ? { detail } : {})
  })
  if (list.length > MAX_SAMPLES) {
    list.splice(0, list.length - MAX_SAMPLES)
  }
}

function percentile(sorted: number[], ratio: number): number {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)
  return sorted[index]
}

function summarize(bucket: SampleBucket): { count: number; p95Ms: number; maxMs: number } {
  const durations = samples[bucket].map((sample) => sample.durationMs).sort((a, b) => a - b)
  return {
    count: durations.length,
    p95Ms: percentile(durations, 0.95),
    maxMs: durations.length > 0 ? durations[durations.length - 1] : 0
  }
}

function buildFailures(summary: StreamingPerfSnapshot['summary']): string[] {
  const failures: string[] = []
  if (summary.longTask.maxMs > LONG_TASK_LIMIT_MS) {
    failures.push(`longTask max ${summary.longTask.maxMs.toFixed(1)}ms > ${LONG_TASK_LIMIT_MS}ms`)
  }
  if (summary.reactCommit.p95Ms > REACT_COMMIT_P95_LIMIT_MS) {
    failures.push(
      `reactCommit p95 ${summary.reactCommit.p95Ms.toFixed(1)}ms > ${REACT_COMMIT_P95_LIMIT_MS}ms`
    )
  }
  if (summary.reactCommit.maxMs > REACT_COMMIT_MAX_LIMIT_MS) {
    failures.push(
      `reactCommit max ${summary.reactCommit.maxMs.toFixed(1)}ms > ${REACT_COMMIT_MAX_LIMIT_MS}ms`
    )
  }
  if (summary.rafGap.p95Ms > RAF_P95_LIMIT_MS) {
    failures.push(`rafGap p95 ${summary.rafGap.p95Ms.toFixed(1)}ms > ${RAF_P95_LIMIT_MS}ms`)
  }
  if (summary.rafGap.maxMs > RAF_MAX_LIMIT_MS) {
    failures.push(`rafGap max ${summary.rafGap.maxMs.toFixed(1)}ms > ${RAF_MAX_LIMIT_MS}ms`)
  }
  return failures
}

export function isStreamingPerfEnabled(): boolean {
  return enabled
}

/** ChatPanel React.Profiler onRender 回调写入 */
export function recordStreamingReactCommit(
  durationMs: number,
  detail?: Record<string, unknown>
): void {
  pushSample('reactCommit', durationMs, detail)
}

function snapshot(): StreamingPerfSnapshot {
  const summary = {
    reactCommit: summarize('reactCommit'),
    rafGap: summarize('rafGap'),
    longTask: summarize('longTask')
  }

  return {
    enabled,
    samples: {
      reactCommit: [...samples.reactCommit],
      rafGap: [...samples.rafGap],
      longTask: [...samples.longTask]
    },
    summary,
    failures: buildFailures(summary)
  }
}

function reset(): void {
  for (const list of Object.values(samples)) {
    list.splice(0)
  }
}

/** 安装全局采样器；重复调用安全。无 window / rAF 的环境（部分单测）静默跳过。 */
export function installStreamingPerfMonitor(): void {
  if (!enabled || installed) return
  if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
    return
  }
  installed = true

  window.__novaStreamingPerf = { snapshot, reset }

  let lastFrame = performance.now()
  const tick = (now: number): void => {
    pushSample('rafGap', now - lastFrame)
    lastFrame = now
    rafId = window.requestAnimationFrame(tick)
  }
  rafId = window.requestAnimationFrame(tick)

  if (typeof PerformanceObserver !== 'undefined') {
    try {
      longTaskObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          pushSample('longTask', entry.duration, {
            name: entry.name,
            startTime: entry.startTime
          })
        }
      })
      longTaskObserver.observe({ entryTypes: ['longtask'] })
    } catch {
      longTaskObserver = null
    }
  }

  window.addEventListener(
    'beforeunload',
    () => {
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId)
        rafId = null
      }
      longTaskObserver?.disconnect()
      longTaskObserver = null
    },
    { once: true }
  )
}

declare global {
  interface Window {
    __novaStreamingPerf?: StreamingPerfApi
  }
}
