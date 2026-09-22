import { describe, expect, it } from 'vitest'
import type { BrowserControlFence } from '../../../../src/main/browser/controlPort'
import { createElectronBrowserDriver } from '../../../../src/main/browser/electronDriver'
import type { BrowserGuestContents, BrowserGuestDebugger } from '../../../../src/main/browser/guestContents'
import { readPngIhdr } from '../../../../src/main/browser/pngIhdr'
import { getPlaywrightInjectedScriptSource } from '../../../../src/main/browser/injectedSource'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

class ScriptedDebugger implements BrowserGuestDebugger {
  attached = false
  readonly calls: Array<{ method: string; params?: Record<string, unknown> }> = []
  private detachListeners = new Set<() => void>()
  private pending: ((value: unknown) => void) | null = null
  mode: 'ok' | 'hang' | 'scroll-still' | 'bad-png' | 'occluded' | 'ambiguous' = 'ok'

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
    if (method === 'Page.getFrameTree') {
      return Promise.resolve({ frameTree: { frame: { id: 'main' } } })
    }
    if (method === 'Page.createIsolatedWorld') {
      return Promise.resolve({ executionContextId: 7 })
    }
    if (method === 'Page.enable' || method === 'Emulation.setDeviceMetricsOverride') {
      return Promise.resolve({})
    }
    if (method === 'Runtime.evaluate') {
      const expression = String(params?.expression ?? '')
      if (this.mode === 'hang' && expression.includes('incrementalAriaSnapshot')) {
        return new Promise((resolve) => {
          this.pending = resolve
        })
      }
      return Promise.resolve({ result: { value: valueFor(expression, this.mode) } })
    }
    return Promise.resolve({})
  }

  releasePending(value: unknown): void {
    this.pending?.(value)
    this.pending = null
  }

  on(event: 'detach' | 'message', listener: (() => void) | ((method: string, params: unknown) => void)): void {
    if (event === 'detach') this.detachListeners.add(listener as () => void)
  }

  off(event: 'detach' | 'message', listener: (() => void) | ((method: string, params: unknown) => void)): void {
    if (event === 'detach') this.detachListeners.delete(listener as () => void)
  }
}

function snapshotValue(mode: ScriptedDebugger['mode']): Record<string, unknown> {
  return {
    url: 'http://127.0.0.1/doc',
    title: 'Doc',
    viewport: { width: 800, height: 600 },
    scrollY: 0,
    dom: mode === 'ambiguous'
      ? '- textbox "邮箱" [ref=e1]\n- textbox "邮箱" [ref=e2]'
      : '- textbox "邮箱" [ref=e1]',
    elements: mode === 'ambiguous'
      ? [
          { ref: 'e1', role: 'textbox', name: '邮箱', selector: 'css=#email', rect: { x: 10, y: 10, width: 120, height: 24 } },
          { ref: 'e2', role: 'textbox', name: '邮箱', selector: 'css=#email', rect: { x: 10, y: 40, width: 120, height: 24 } }
        ]
      : [{ ref: 'e1', role: 'textbox', name: '邮箱', selector: 'css=#email', rect: { x: 10, y: 10, width: 120, height: 24 } }],
    truncated: false,
    limits: []
  }
}

function valueFor(expression: string, mode: ScriptedDebugger['mode']): unknown {
  if (expression.includes('InjectedScript')) return true
  if (expression.includes('incrementalAriaSnapshot')) return snapshotValue(mode)
  if (expression.includes('innerWidth')) return { width: 320, height: 240 }
  if (expression.includes('checkElementStates')) {
    if (mode === 'occluded') return { code: 'target_occluded', detail: '点击点被 div 遮挡' }
    if (mode === 'ambiguous') return { code: 'target_ambiguous', detail: '目标不唯一' }
    return { code: 'ok', x: 70, y: 22, width: 120, height: 24 }
  }
  if (expression.includes('scrollBy')) {
    return mode === 'scroll-still' ? { before: 0, after: 0 } : { before: 0, after: 400 }
  }
  if (expression.includes('readyState')) {
    return { href: 'http://127.0.0.1/next', readyState: 'complete' }
  }
  return { count: 1, used: 'fallback' }
}

class ScriptedGuest implements BrowserGuestContents {
  readonly id = 1
  url = 'http://127.0.0.1/doc'
  readonly debugger: ScriptedDebugger
  loadError: unknown = null
  png: Buffer | null = PNG

  constructor(dbg?: ScriptedDebugger) {
    this.debugger = dbg ?? new ScriptedDebugger()
  }

  getType(): string {
    return 'webview'
  }

  isDestroyed(): boolean {
    return false
  }

  isCrashed(): boolean {
    return false
  }

  getURL(): string {
    return this.url
  }

  getTitle(): string {
    return 'Doc'
  }

  isLoading(): boolean {
    return false
  }

  async loadURL(url: string): Promise<void> {
    if (this.loadError) {
      if (this.url === 'http://127.0.0.1/doc') this.url = 'http://127.0.0.1/next'
      else this.url = 'http://127.0.0.1/other'
      throw this.loadError
    }
    this.url = url
  }

  goBack(): void {}
  goForward(): void {}
  reload(): void {}
  stop(): void {}
  setWindowOpenHandler(): void {}

  async capturePage(): Promise<{ toPNG(): Buffer; getSize(): { width: number; height: number } }> {
    const bytes = this.png ?? Buffer.from('not-a-png')
    return {
      toPNG: () => bytes,
      getSize: () => ({ width: 1, height: 1 })
    }
  }

  on(): void {}
  off(): void {}
}

function openFence(current = true, signal?: AbortSignal): BrowserControlFence & { allow: boolean } {
  const fence = {
    generation: 1,
    documentEpoch: 1,
    observationId: 'obs_1',
    signal,
    allow: current,
    stillCurrent() {
      return this.allow ? { ok: true as const } : { ok: false as const, code: 'taken_over' as const }
    }
  }
  return fence
}

describe('ElectronBrowserDriver', () => {
  it('只读取注入脚本字符串，不连接 Playwright', () => {
    const source = getPlaywrightInjectedScriptSource()
    expect(source).toContain('incrementalAriaSnapshot')
    expect(source).toContain('InjectedScript')
  })

  it('隔离世界拒绝 universal access，evaluate 必须带 contextId', async () => {
    const guest = new ScriptedGuest()
    const driver = createElectronBrowserDriver({ idleMs: 60_000, commandDeadlineMs: 1_000 })
    const result = await driver.observe(guest, openFence())
    expect(result.status).toBe('applied')
    const world = guest.debugger.calls.find((call) => call.method === 'Page.createIsolatedWorld')
    expect(world?.params).toMatchObject({ grantUniveralAccess: false, worldName: 'nova-browser' })
    const evaluations = guest.debugger.calls.filter((call) => call.method === 'Runtime.evaluate')
    expect(evaluations.length).toBeGreaterThan(0)
    expect(evaluations.every((call) => call.params?.contextId === 7)).toBe(true)
    driver.release(guest)
  })

  it('两段快照：语义行与元素细节都通过，refs 从元素细节提取', async () => {
    const guest = new ScriptedGuest()
    const driver = createElectronBrowserDriver({ idleMs: 60_000, commandDeadlineMs: 1_000 })
    const result = await driver.observe(guest, openFence())
    expect(result.status).toBe('applied')
    if (result.status !== 'applied') return
    expect(result.read.snapshot.dom).toContain('[ref=e1]')
    expect(result.read.snapshot.elements[0]).toMatchObject({
      ref: 'e1',
      selector: 'css=#email',
      rect: { x: 10, y: 10, width: 120, height: 24 }
    })
    expect(result.read.refs).toEqual({ e1: 'css=#email' })
    driver.release(guest)
  })

  it('点击前命中测试被遮挡时返回 target_occluded，不派发鼠标事件', async () => {
    const guest = new ScriptedGuest()
    guest.debugger.mode = 'occluded'
    const driver = createElectronBrowserDriver({ idleMs: 60_000, commandDeadlineMs: 1_000 })
    driver.bindRefs('obs_1', { e1: 'css=#email' })
    const result = await driver.act(guest, openFence(), { kind: 'click', ref: 'e1' })
    expect(result).toMatchObject({ status: 'not_applied', code: 'target_occluded' })
    const mouse = guest.debugger.calls.filter((call) => call.method === 'Input.dispatchMouseEvent')
    expect(mouse.length).toBe(0)
    driver.release(guest)
  })

  it('目标不唯一时点击返回 target_ambiguous', async () => {
    const guest = new ScriptedGuest()
    guest.debugger.mode = 'ambiguous'
    const driver = createElectronBrowserDriver({ idleMs: 60_000, commandDeadlineMs: 1_000 })
    driver.bindRefs('obs_1', { e1: 'css=#email' })
    const result = await driver.act(guest, openFence(), { kind: 'click', ref: 'e1' })
    expect(result).toMatchObject({ status: 'not_applied', code: 'target_ambiguous' })
    driver.release(guest)
  })

  it('滚动没有改变 scrollY 时返回 not_applied', async () => {
    const guest = new ScriptedGuest()
    guest.debugger.mode = 'scroll-still'
    const driver = createElectronBrowserDriver({ idleMs: 60_000, commandDeadlineMs: 1_000 })
    const result = await driver.act(guest, openFence(), { kind: 'scroll', direction: 'down', amount: 'page' })
    expect(result).toMatchObject({ status: 'not_applied', code: 'unavailable' })
    if (result.status === 'not_applied') expect(result.detail).toContain('scrollY')
    driver.release(guest)
  })

  it('截图校验 PNG，无效图返回 capture_not_ready 而不抛出', async () => {
    const guest = new ScriptedGuest()
    const driver = createElectronBrowserDriver({ idleMs: 60_000, commandDeadlineMs: 1_000 })
    const ok = await driver.capture(guest, openFence())
    expect(ok.status).toBe('applied')
    if (ok.status === 'applied') {
      const size = readPngIhdr(Buffer.from(ok.base64, 'base64'))
      expect(size).toEqual({ width: 1, height: 1 })
    }
    guest.png = Buffer.from('nope')
    const bad = await driver.capture(guest, openFence())
    expect(bad).toMatchObject({ status: 'not_applied', code: 'capture_not_ready' })
    driver.release(guest)
  })

  it('世代变化后丢弃迟到的观察结果', async () => {
    const guest = new ScriptedGuest()
    guest.debugger.mode = 'hang'
    const driver = createElectronBrowserDriver({ idleMs: 60_000, commandDeadlineMs: 1_000 })
    const fence = openFence()
    const pending = driver.observe(guest, fence)
    await new Promise((resolve) => setTimeout(resolve, 20))
    fence.allow = false
    guest.debugger.releasePending({
      result: {
        value: {
          url: 'http://127.0.0.1/doc',
          title: 'late',
          viewport: { width: 10, height: 10 },
          dom: '- heading "不应该被采纳"',
          elements: [],
          truncated: false,
          limits: []
        }
      }
    })
    const result = await pending
    expect(result.status).toBe('not_applied')
    if (result.status === 'applied') {
      throw new Error('迟到观察被写成了已应用')
    }
    driver.release(guest)
  })

  it('命令超时返回 timeout', async () => {
    const guest = new ScriptedGuest()
    guest.debugger.mode = 'hang'
    const driver = createElectronBrowserDriver({ idleMs: 60_000, commandDeadlineMs: 40 })
    const result = await driver.observe(guest, openFence())
    expect(result).toMatchObject({ status: 'not_applied', code: 'timeout' })
    driver.release(guest)
  })

  it('DevTools detach 后后续命令立即返回 debugger_detached', async () => {
    const guest = new ScriptedGuest()
    guest.debugger.mode = 'hang'
    const driver = createElectronBrowserDriver({ idleMs: 60_000, commandDeadlineMs: 5_000 })
    const pending = driver.observe(guest, openFence())
    await new Promise((resolve) => setTimeout(resolve, 15))
    guest.debugger.detach()
    await expect(pending).resolves.toMatchObject({
      status: 'not_applied',
      code: 'debugger_detached'
    })
    const started = Date.now()
    const next = await driver.observe(guest, openFence())
    expect(Date.now() - started).toBeLessThan(200)
    expect(next).toMatchObject({ status: 'not_applied', code: 'debugger_detached' })
    driver.release(guest)
  })

  it('ERR_ABORTED 在地址和 readyState 对上时不算失败', async () => {
    const guest = new ScriptedGuest()
    guest.loadError = Object.assign(new Error('ERR_ABORTED (-3) loading'), { errno: -3 })
    const driver = createElectronBrowserDriver({
      idleMs: 60_000,
      commandDeadlineMs: 1_000,
      abortedNavigationMs: 200
    })
    const loaded = await driver.load(guest, openFence(), 'http://127.0.0.1/next')
    expect(loaded).toEqual({ status: 'applied' })
    guest.url = 'http://127.0.0.1/other'
    const missed = await driver.load(guest, openFence(), 'http://127.0.0.1/next')
    expect(missed).toMatchObject({ status: 'not_applied', code: 'navigation_failed' })
    driver.release(guest)
  })
})
