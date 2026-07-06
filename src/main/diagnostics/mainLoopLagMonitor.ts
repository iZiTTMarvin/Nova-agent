/**
 * 主进程 event-loop lag 监控（perf_hooks.monitorEventLoopDelay）
 *
 * 只读采样，不改任何业务执行路径。开发环境周期性 console.warn 超阈值 lag，
 * 并通过 IPC + preload 暴露 window.__novaMainLoopLag（与 streamingPerf 对齐）。
 */

import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks'
import type { MainLoopLagApi, MainLoopLagSnapshot } from '../../shared/diagnostics/mainLoopLagTypes'

/** histogram 分辨率（ms）；越小越细，开销略增 */
const RESOLUTION_MS = 10

/** p99 超过此值打印 warn（与 stallDetector 一样用阈值告警，非阻塞） */
const WARN_P99_MS = 50

/** max 超过此值打印 warn */
const WARN_MAX_MS = 200

/** 开发环境周期性检查间隔 */
const CHECK_INTERVAL_MS = 5000

/** 纳秒 → 毫秒 */
export function nsToMs(ns: number): number {
  return ns / 1_000_000
}

function buildSnapshot(histogram: IntervalHistogram, enabled: boolean): MainLoopLagSnapshot {
  return {
    enabled,
    resolutionMs: RESOLUTION_MS,
    sampleCount: histogram.count,
    p50Ms: nsToMs(histogram.percentile(50)),
    p99Ms: nsToMs(histogram.percentile(99)),
    maxMs: nsToMs(histogram.max)
  }
}

let histogram: IntervalHistogram | null = null
let checkTimer: ReturnType<typeof setInterval> | null = null
let installed = false

function maybeWarn(snapshot: MainLoopLagSnapshot): void {
  if (snapshot.sampleCount === 0) return
  if (snapshot.p99Ms >= WARN_P99_MS || snapshot.maxMs >= WARN_MAX_MS) {
    // eslint-disable-next-line no-console
    console.warn(
      `[main-loop-lag] p50=${snapshot.p50Ms.toFixed(1)}ms ` +
        `p99=${snapshot.p99Ms.toFixed(1)}ms max=${snapshot.maxMs.toFixed(1)}ms ` +
        `(主进程 event loop 延迟偏高，同步 IO 或重计算可能阻塞 UI)`
    )
  }
}

const api: MainLoopLagApi = {
  snapshot(): MainLoopLagSnapshot {
    if (!histogram) {
      return {
        enabled: false,
        resolutionMs: RESOLUTION_MS,
        sampleCount: 0,
        p50Ms: 0,
        p99Ms: 0,
        maxMs: 0
      }
    }
    return buildSnapshot(histogram, true)
  },
  reset(): void {
    histogram?.reset()
  }
}

/**
 * 启动主进程 event-loop lag 采样。
 * @param options.devOnly 为 true 时仅在 development 启用周期性告警与 renderer 桥接
 */
export function installMainLoopLagMonitor(options?: { devOnly?: boolean }): MainLoopLagApi {
  if (installed) return api
  installed = true

  histogram = monitorEventLoopDelay({ resolution: RESOLUTION_MS })
  histogram.enable()

  const isDev = process.env.NODE_ENV === 'development'
  const enablePeriodicWarn = options?.devOnly !== false ? isDev : true

  if (enablePeriodicWarn) {
    checkTimer = setInterval(() => {
      maybeWarn(api.snapshot())
    }, CHECK_INTERVAL_MS)
    // 不阻止进程退出
    checkTimer.unref?.()
  }

  return api
}

/** 停止采样（测试或进程退出时） */
export function disposeMainLoopLagMonitor(): void {
  if (checkTimer) {
    clearInterval(checkTimer)
    checkTimer = null
  }
  histogram?.disable()
  histogram = null
  installed = false
}

export function getMainLoopLagApi(): MainLoopLagApi {
  return api
}
