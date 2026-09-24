import { describe, expect, it } from 'vitest'
import type { BrowserControlFence } from '../../../../src/main/browser/controlPort'
import {
  actionabilityExpression,
  captureReadinessProbeExpression,
  fillExpression,
  focusExpression
} from '../../../../src/main/browser/controlledScripts'
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
  viewportProbe: { width: number; height: number; devicePixelRatio: number } | null = null
  onProbe: (() => void) | null = null
  readiness: { ready: boolean; reason: string | null } = { ready: true, reason: null }
  readinessQueue: Array<{ ready: boolean; reason: string | null }> = []
  readinessHang = false
  sensitiveSelectors: string[] = []

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
      if (expression.includes('novaViewportProbe')) {
        this.onProbe?.()
        return Promise.resolve({
          result: {
            value: this.viewportProbe
              ? { novaViewportProbe: true, ...this.viewportProbe }
              : { novaViewportProbe: true, width: 0, height: 0, devicePixelRatio: 1 }
          }
        })
      }
      if (expression.includes('novaCaptureReadiness')) {
        if (this.readinessHang) {
          return new Promise(() => {})
        }
        const next = this.readinessQueue.shift() ?? this.readiness
        return Promise.resolve({
          result: { value: { novaCaptureReadiness: true, ready: next.ready, reason: next.reason } }
        })
      }
      if (this.mode === 'hang' && expression.includes('incrementalAriaSnapshot')) {
        return new Promise((resolve) => {
          this.pending = resolve
        })
      }
      return Promise.resolve({ result: { value: valueFor(expression, this) } })
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

function valueFor(expression: string, dbg: ScriptedDebugger): unknown {
  if (expression.includes('InjectedScript')) return true
  if (expression.includes('incrementalAriaSnapshot')) return snapshotValue(dbg.mode)
  if (expression.includes('sensitiveReason')) {
    const sensitive = dbg.sensitiveSelectors.some((selector) =>
      expression.includes(JSON.stringify(selector))
    )
    if (sensitive) return { code: 'unsupported', detail: '密码或验证码字段需要用户手动填写' }
    return { count: 1, used: 'fallback' }
  }
  if (expression.includes('checkElementStates')) {
    if (dbg.mode === 'occluded') return { code: 'target_occluded', detail: '点击点被 div 遮挡' }
    if (dbg.mode === 'ambiguous') return { code: 'target_ambiguous', detail: '目标不唯一' }
    return { code: 'ok', x: 70, y: 22, width: 120, height: 24 }
  }
  if (expression.includes('scrollBy')) {
    return dbg.mode === 'scroll-still' ? { before: 0, after: 0 } : { before: 0, after: 400 }
  }
  if (expression.includes('readyState')) {
    return { href: 'http://127.0.0.1/next', readyState: 'complete' }
  }
  if (expression.includes('innerWidth')) return { width: 320, height: 240 }
  return { count: 1, used: 'fallback' }
}

class ScriptedGuest implements BrowserGuestContents {
  readonly id = 1
  url = 'http://127.0.0.1/doc'
  readonly debugger: ScriptedDebugger
  loadError: unknown = null
  loadHang = false
  png: Buffer | null = PNG
  readonly loadCalls: string[] = []

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
    this.loadCalls.push(url)
    if (this.loadHang) return new Promise(() => {})
    if (this.loadError) {
      if (this.url === 'http://127.0.0.1/doc') this.url = 'http://127.0.0.1/next'
      else this.url = 'http://127.0.0.1/other'
      throw this.loadError
    }
    this.url = url
  }

  goBack(): void {}
  goForward(): void {}
  historyTarget(): string | null { return null }
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

  it('截图前等就绪：字体或图片未就绪时按具体原因拒绝', async () => {
    const guest = new ScriptedGuest()
    guest.debugger.readiness = { ready: false, reason: 'fonts' }
    const driver = createElectronBrowserDriver({ idleMs: 60_000, commandDeadlineMs: 1_000 })
    const notReady = await driver.capture(guest, openFence())
    expect(notReady).toMatchObject({ status: 'not_applied', code: 'capture_not_ready' })
    if (notReady.status === 'not_applied') expect(notReady.detail).toContain('fonts')
    guest.debugger.readiness = { ready: false, reason: 'images' }
    const imagePending = await driver.capture(guest, openFence())
    expect(imagePending).toMatchObject({ status: 'not_applied', code: 'capture_not_ready' })
    if (imagePending.status === 'not_applied') expect(imagePending.detail).toContain('images')
    guest.debugger.readiness = { ready: true, reason: null }
    const ready = await driver.capture(guest, openFence())
    expect(ready.status).toBe('applied')
    driver.release(guest)
  })

  it('同一次截图内未就绪转就绪必须走成功分支', async () => {
    const guest = new ScriptedGuest()
    // 第一次探测 images 未就绪，轮询后第二次就绪：不能沿用旧原因拒绝
    guest.debugger.readinessQueue = [
      { ready: false, reason: 'images' },
      { ready: true, reason: null }
    ]
    const driver = createElectronBrowserDriver({ idleMs: 60_000, commandDeadlineMs: 2_000 })
    const captured = await driver.capture(guest, openFence())
    expect(captured).toMatchObject({ status: 'applied' })
    driver.release(guest)
  })

  it('挂起的就绪探测受就绪预算约束，不吃掉整个命令时限', async () => {
    const guest = new ScriptedGuest()
    guest.debugger.readinessHang = true
    const driver = createElectronBrowserDriver({ idleMs: 60_000, commandDeadlineMs: 5_000 })
    const started = Date.now()
    const result = await driver.capture(guest, openFence())
    expect(Date.now() - started).toBeLessThan(3_000)
    expect(result).toMatchObject({ status: 'not_applied', code: 'capture_not_ready' })
    driver.release(guest)
  })

  it('导航发出前租约已失效时不调用 loadURL', async () => {
    const guest = new ScriptedGuest()
    const driver = createElectronBrowserDriver({ idleMs: 60_000, commandDeadlineMs: 1_000 })
    const result = await driver.load(guest, openFence(false), 'http://127.0.0.1/gone')
    expect(result).toMatchObject({ status: 'not_applied', code: 'taken_over' })
    expect(guest.loadCalls).toEqual([])
    driver.release(guest)
  })

  it('密码与验证码字段拒绝代填和按键，普通输入保持原行为', async () => {
    const guest = new ScriptedGuest()
    guest.debugger.sensitiveSelectors = ['css=#pass', 'css=#otp']
    const driver = createElectronBrowserDriver({ idleMs: 60_000, commandDeadlineMs: 1_000 })
    driver.bindRefs('obs_1', { pass: 'css=#pass', otp: 'css=#otp', email: 'css=#email', agree: 'css=#agree' })
    await expect(driver.act(guest, openFence(), { kind: 'fill', ref: 'pass', text: 'secret' }))
      .resolves.toMatchObject({ status: 'not_applied', code: 'unsupported' })
    await expect(driver.act(guest, openFence(), { kind: 'fill', ref: 'otp', text: '123456' }))
      .resolves.toMatchObject({ status: 'not_applied', code: 'unsupported' })
    await expect(driver.act(guest, openFence(), { kind: 'press', ref: 'pass', key: 'a' }))
      .resolves.toMatchObject({ status: 'not_applied', code: 'unsupported' })
    // 普通文本与点击不受影响
    await expect(driver.act(guest, openFence(), { kind: 'fill', ref: 'email', text: 'a@b.c' }))
      .resolves.toMatchObject({ status: 'applied' })
    await expect(driver.act(guest, openFence(), { kind: 'press', ref: 'email', key: 'Enter' }))
      .resolves.toMatchObject({ status: 'applied' })
    await expect(driver.act(guest, openFence(), { kind: 'click', ref: 'agree' }))
      .resolves.toMatchObject({ status: 'applied' })
    driver.release(guest)
  })

  it('受控脚本带防护逻辑：点击前按裁剪交集滚入并取交集中心，填写前判敏感字段', () => {
    const click = actionabilityExpression('css=#btn', true)
    expect(click).toContain('scrollIntoView')
    expect(click).toContain('clippedIntersection')
    expect(click).toContain('getComputedStyle')
    expect(click).toContain('overflowY')
    expect(click).toContain('Math.max(rect.left, 0)')
    expect(click).toContain('Math.min(rect.right, viewportWidth)')
    const fillOnly = actionabilityExpression('css=#email', false)
    expect(fillOnly).not.toContain('scrollIntoView')
    expect(fillOnly).not.toContain('clippedIntersection')
    const fill = fillExpression('css=#email', 'text')
    expect(fill).toContain('sensitiveReason')
    expect(fill.indexOf('sensitiveReason(element, view)')).toBeLessThan(fill.indexOf('element.focus()'))
    const focus = focusExpression('css=#email')
    expect(focus).toContain('sensitiveReason')
    const readiness = captureReadinessProbeExpression()
    expect(readiness).toContain('document.fonts')
    expect(readiness).toContain('document.images')
    expect(readiness).toContain('requestAnimationFrame')
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

  it('挂起的 loadURL 在命令时限内返回 timeout', async () => {
    const guest = new ScriptedGuest()
    guest.loadHang = true
    const driver = createElectronBrowserDriver({ idleMs: 60_000, commandDeadlineMs: 40 })
    const started = Date.now()
    const result = await driver.load(guest, openFence(), 'http://127.0.0.1/hung')
    expect(Date.now() - started).toBeLessThan(500)
    expect(result).toMatchObject({ status: 'not_applied', code: 'timeout' })
    driver.release(guest)
  })

  it('取消挂起的 loadURL 会 stop 并返回 cancelled', async () => {
    const guest = new ScriptedGuest()
    guest.loadHang = true
    const abort = new AbortController()
    const driver = createElectronBrowserDriver({ idleMs: 60_000, commandDeadlineMs: 2_000 })
    const pending = driver.load(guest, openFence(true, abort.signal), 'http://127.0.0.1/hung')
    await new Promise((resolve) => setTimeout(resolve, 15))
    abort.abort()
    const started = Date.now()
    await expect(pending).resolves.toMatchObject({ status: 'not_applied', code: 'cancelled' })
    expect(Date.now() - started).toBeLessThan(500)
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

  it('视口只有在页面尺寸真的变成目标值后才算模拟成功', async () => {
    const guest = new ScriptedGuest()
    guest.debugger.viewportProbe = { width: 390, height: 844, devicePixelRatio: 1 }
    const driver = createElectronBrowserDriver({ idleMs: 60_000 })
    const applied = await driver.act(guest, openFence(), {
      kind: 'viewport',
      width: 390,
      height: 844,
      device: 'mobile'
    })
    expect(applied).toMatchObject({ status: 'applied' })
    expect(guest.debugger.calls.some((call) => call.method === 'Emulation.clearDeviceMetricsOverride')).toBe(true)
    expect(guest.debugger.calls.some((call) => call.method === 'Emulation.setDeviceMetricsOverride')).toBe(false)
    const observed = await driver.observe(guest, openFence())
    expect(observed.status).toBe('applied')
    if (observed.status === 'applied') {
      expect(observed.read.snapshot.viewport).toMatchObject({
        device: 'mobile',
        simulated: true,
        deviceScaleFactor: 1
      })
    }
    driver.release(guest)
  })

  it('页面尺寸对不上时不把视口当成已验收，并清掉这次覆盖', async () => {
    const guest = new ScriptedGuest()
    guest.debugger.viewportProbe = { width: 100, height: 100, devicePixelRatio: 1 }
    const driver = createElectronBrowserDriver({ idleMs: 60_000 })
    const missed = await driver.act(guest, openFence(), {
      kind: 'viewport',
      width: 390,
      height: 844,
      device: 'mobile'
    })
    expect(missed).toMatchObject({ status: 'not_applied', code: 'unsupported' })
    expect(guest.debugger.calls.some((call) => call.method === 'Emulation.clearDeviceMetricsOverride')).toBe(true)
    driver.release(guest)
  })

  it('视口探测期间租约变化就停住，不再恢复旧尺寸', async () => {
    const guest = new ScriptedGuest()
    const fence = openFence()
    guest.debugger.viewportProbe = { width: 390, height: 844, devicePixelRatio: 1 }
    guest.debugger.onProbe = () => {
      fence.allow = false
    }
    const driver = createElectronBrowserDriver({ idleMs: 60_000 })
    const interrupted = await driver.act(guest, fence, {
      kind: 'viewport',
      width: 390,
      height: 844,
      device: 'mobile'
    })
    expect(interrupted).toMatchObject({ status: 'not_applied', code: 'taken_over' })
    expect(guest.debugger.calls.filter((call) => call.method === 'Emulation.clearDeviceMetricsOverride')).toHaveLength(1)
    expect(guest.debugger.calls.filter((call) => call.method === 'Emulation.setDeviceMetricsOverride')).toHaveLength(0)
    driver.release(guest)
  })

  it('已验收的模拟尺寸在下一次视口被接管时仍然保留', async () => {
    const guest = new ScriptedGuest()
    const fence = openFence()
    guest.debugger.viewportProbe = { width: 390, height: 844, devicePixelRatio: 1 }
    const driver = createElectronBrowserDriver({ idleMs: 60_000 })
    const applied = await driver.act(guest, fence, {
      kind: 'viewport',
      width: 390,
      height: 844,
      device: 'mobile'
    })
    expect(applied).toMatchObject({ status: 'applied' })
    guest.debugger.onProbe = () => {
      fence.allow = false
    }
    const interrupted = await driver.act(guest, fence, {
      kind: 'viewport',
      width: 1280,
      height: 800,
      device: 'desktop'
    })
    expect(interrupted).toMatchObject({ status: 'not_applied', code: 'taken_over' })
    fence.allow = true
    const observed = await driver.observe(guest, fence)
    expect(observed.status).toBe('applied')
    if (observed.status === 'applied') {
      expect(observed.read.snapshot.viewport).toMatchObject({
        device: 'mobile',
        simulated: true
      })
    }
    expect(guest.debugger.calls.filter((call) => call.method === 'Emulation.setDeviceMetricsOverride')).toHaveLength(0)
    driver.release(guest)
  })
})
