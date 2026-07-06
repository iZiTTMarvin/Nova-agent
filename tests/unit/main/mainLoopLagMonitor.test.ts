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
