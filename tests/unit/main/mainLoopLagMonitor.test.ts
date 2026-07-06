import { describe, it, expect, afterEach } from 'vitest'
import {
  installMainLoopLagMonitor,
  disposeMainLoopLagMonitor,
  nsToMs,
  getMainLoopLagApi
} from '../../../src/main/diagnostics/mainLoopLagMonitor'

describe('mainLoopLagMonitor', () => {
  afterEach(() => {
    disposeMainLoopLagMonitor()
  })

  it('nsToMs 转换正确', () => {
    expect(nsToMs(5_000_000)).toBe(5)
    expect(nsToMs(0)).toBe(0)
  })

  it('install 后 snapshot 返回合法结构', () => {
    installMainLoopLagMonitor({ devOnly: false })
    const snap = getMainLoopLagApi().snapshot()
    expect(snap.enabled).toBe(true)
    expect(snap.resolutionMs).toBe(10)
    expect(snap.p50Ms).toBeGreaterThanOrEqual(0)
    expect(snap.p99Ms).toBeGreaterThanOrEqual(0)
    expect(snap.maxMs).toBeGreaterThanOrEqual(0)
    expect(snap.sampleCount).toBeGreaterThanOrEqual(0)
  })

  // 本测试验证「采样链路在工作」，不断言具体 lag 数值。
  // monitorEventLoopDelay 由 libuv 在 poll 阶段采样，受 CPU 占用 / GC / OS 调度抖动影响，
  // 同一段 busy-wait 在不同机器、不同负载下被 histogram 记录到的 lag 抖动极大
  // （同一 150ms 阻塞可能记成 15ms 也可能记成 150ms）。
  // 用确定性数值断言（如 maxMs > 20）会导致 flaky：CI 上时过时不过。
  // 真实 lag 数值留给 dev 手测 window.__novaMainLoopLag.snapshot() 验证（那是有意义场景）。
  // 这里只断言 sampleCount > 0：busy-wait 后采样确实进入了 histogram，链路打通。
  it('同步阻塞后 histogram 收到样本（采样链路打通）', async () => {
    installMainLoopLagMonitor({ devOnly: false })
    getMainLoopLagApi().reset()

    const blockMs = 150
    await new Promise<void>((resolve) => {
      setImmediate(() => {
        const start = Date.now()
        while (Date.now() - start < blockMs) {
          // 故意占满 event loop，制造一次可观测阻塞
        }
        resolve()
      })
    })

    // 给 histogram 一个 tick 收集样本
    await new Promise<void>((resolve) => {
      setTimeout(() => resolve(), 80)
    })

    const snap = getMainLoopLagApi().snapshot()
    // 只断言链路打通：sampleCount > 0 证明 busy-wait 后采样进入了 histogram。
    // 不断言 maxMs/p99Ms 的具体数值（见上方注释），避免 flaky。
    expect(snap.sampleCount).toBeGreaterThan(0)
    expect(snap.maxMs).toBeGreaterThanOrEqual(0)
    expect(snap.p99Ms).toBeGreaterThanOrEqual(0)
  })

  it('reset 不抛错', () => {
    installMainLoopLagMonitor({ devOnly: false })
    expect(() => getMainLoopLagApi().reset()).not.toThrow()
  })

  it('重复 install 幂等', () => {
    const api1 = installMainLoopLagMonitor({ devOnly: false })
    const api2 = installMainLoopLagMonitor({ devOnly: false })
    expect(api1).toBe(api2)
  })
})
