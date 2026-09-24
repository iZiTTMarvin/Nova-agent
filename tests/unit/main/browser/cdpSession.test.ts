import { describe, expect, it } from 'vitest'
import { createCdpSession, type BrowserDeviceMetrics } from '../../../../src/main/browser/cdpSession'
import type { BrowserControlFence } from '../../../../src/main/browser/controlPort'
import type { BrowserGuestDebugger } from '../../../../src/main/browser/guestContents'

class FakeTransport implements BrowserGuestDebugger {
  attached = false
  readonly calls: Array<{ method: string; params?: Record<string, unknown> }> = []
  private detachListeners = new Set<() => void>()
  hold: ((value: unknown) => void) | null = null

  isAttached(): boolean {
    return this.attached
  }

  attach(): void {
    this.attached = true
  }

  detach(): void {
    this.attached = false
    for (const listener of [...this.detachListeners]) listener()
  }

  sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ method, params })
    if (this.hold && method !== 'Page.enable' && method !== 'Emulation.setDeviceMetricsOverride') {
      return new Promise((resolve) => {
        this.hold = resolve
      })
    }
    return Promise.resolve({ ok: true })
  }

  on(event: 'detach' | 'message', listener: (() => void) | ((method: string, params: unknown) => void)): void {
    if (event === 'detach') this.detachListeners.add(listener as () => void)
  }

  off(event: 'detach' | 'message', listener: (() => void) | ((method: string, params: unknown) => void)): void {
    if (event === 'detach') this.detachListeners.delete(listener as () => void)
  }
}

function fence(signal?: AbortSignal): BrowserControlFence {
  return {
    generation: 1,
    documentEpoch: 1,
    observationId: null,
    signal,
    stillCurrent: () => ({ ok: true })
  }
}

const metrics: BrowserDeviceMetrics = {
  width: 800,
  height: 600,
  deviceScaleFactor: 1,
  mobile: false,
  dontSetVisibleSize: true
}

describe('CDP 短连接', () => {
  it('超过时限返回 timeout，迟到的成功值不会再变成结果', async () => {
    const transport = new FakeTransport()
    let late: ((value: unknown) => void) | null = null
    transport.sendCommand = (method, params) => {
      transport.calls.push({ method, params })
      if (method === 'Page.enable') return Promise.resolve({})
      return new Promise((resolve) => {
        late = resolve
      })
    }
    const session = createCdpSession(transport, { idleMs: 60_000 })
    const result = await session.send('Runtime.evaluate', { expression: '1' }, fence(), 30)
    expect(result).toMatchObject({ ok: false, failure: { status: 'not_applied', code: 'timeout' } })
    late?.({ result: { value: 1 } })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(result.ok).toBe(false)
    session.release()
  })

  it('取消后丢弃随后到达的成功值', async () => {
    const transport = new FakeTransport()
    let late: ((value: unknown) => void) | null = null
    transport.sendCommand = (method, params) => {
      transport.calls.push({ method, params })
      if (method === 'Page.enable') return Promise.resolve({})
      return new Promise((resolve) => {
        late = resolve
      })
    }
    const session = createCdpSession(transport, { idleMs: 60_000 })
    const controller = new AbortController()
    const pending = session.send('Runtime.evaluate', { expression: '1' }, fence(controller.signal), 5_000)
    controller.abort()
    const result = await pending
    expect(result).toMatchObject({ ok: false, failure: { code: 'cancelled' } })
    late?.({ result: { value: 'applied' } })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(result.ok).toBe(false)
    session.release()
  })

  it('外部 detach 立即停控，后续命令不再等待', async () => {
    const transport = new FakeTransport()
    transport.sendCommand = (method, params) => {
      transport.calls.push({ method, params })
      if (method === 'Page.enable') return Promise.resolve({})
      return new Promise(() => undefined)
    }
    const session = createCdpSession(transport, { idleMs: 60_000 })
    const pending = session.send('Runtime.evaluate', { expression: '1' }, fence(), 5_000)
    await new Promise((resolve) => setTimeout(resolve, 10))
    transport.detach()
    const result = await pending
    expect(result).toMatchObject({ ok: false, failure: { code: 'debugger_detached' } })
    const started = Date.now()
    const next = await session.send('Runtime.evaluate', { expression: '2' }, fence(), 5_000)
    expect(Date.now() - started).toBeLessThan(200)
    expect(next).toMatchObject({ ok: false, failure: { code: 'debugger_detached' } })
    session.release()
  })

  it('空闲释放后重连会重放 Page.enable 和视口覆盖', async () => {
    const transport = new FakeTransport()
    const session = createCdpSession(transport, { idleMs: 30 })
    session.setDeviceMetrics(metrics)
    const first = await session.send('Runtime.evaluate', { expression: '1' }, fence(), 1_000)
    expect(first.ok).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(transport.attached).toBe(false)
    transport.calls.length = 0
    const second = await session.send('Runtime.evaluate', { expression: '2' }, fence(), 1_000)
    expect(second.ok).toBe(true)
    expect(transport.calls.map((call) => call.method)).toEqual([
      'Page.enable',
      'Emulation.setDeviceMetricsOverride',
      'Runtime.evaluate'
    ])
    expect(transport.calls[1]?.params).toMatchObject({ width: 800, height: 600, deviceScaleFactor: 1 })
    session.release()
  })
})
