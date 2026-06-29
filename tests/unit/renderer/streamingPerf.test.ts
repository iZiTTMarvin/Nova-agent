import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import {
  installStreamingPerfMonitor,
  isStreamingPerfEnabled,
  recordStreamingReactCommit
} from '../../../src/renderer/lib/streamingPerf'

const hasBrowserRuntime =
  typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function'

describe('streamingPerf', () => {
  beforeEach(() => {
    if (hasBrowserRuntime) {
      window.__novaStreamingPerf?.reset()
    }
  })

  afterEach(() => {
    if (hasBrowserRuntime) {
      window.__novaStreamingPerf?.reset()
    }
  })

  it('recordStreamingReactCommit 在 DEV + 浏览器环境应写入 snapshot', () => {
    if (!isStreamingPerfEnabled() || !hasBrowserRuntime) {
      return
    }

    installStreamingPerfMonitor()
    recordStreamingReactCommit(12.5, { phase: 'update' })
    recordStreamingReactCommit(8, { phase: 'update' })

    const snap = window.__novaStreamingPerf?.snapshot()
    expect(snap?.summary.reactCommit.count).toBeGreaterThanOrEqual(2)
    expect(snap?.summary.reactCommit.maxMs).toBeGreaterThanOrEqual(12.5)
  })

  it('reset 应清空样本', () => {
    if (!isStreamingPerfEnabled() || !hasBrowserRuntime) return

    installStreamingPerfMonitor()
    recordStreamingReactCommit(20)
    window.__novaStreamingPerf?.reset()
    const snap = window.__novaStreamingPerf?.snapshot()
    expect(snap?.summary.reactCommit.count).toBe(0)
  })

  it('installStreamingPerfMonitor 在无 rAF 环境应 no-op', () => {
    // 纯逻辑：不抛错即可（vitest node 环境可能无完整 window）
    expect(() => installStreamingPerfMonitor()).not.toThrow()
  })
})
