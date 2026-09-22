/**
 * 把已授权的观察、操作、截图和导航映射到指定 guest。
 * 页面脚本只在隔离世界执行；截图走 capturePage，不走会楔住的 CDP 截图。
 */
import {
  browserNotApplied,
  type BrowserAction,
  type BrowserInteractiveItem,
  type BrowserNotApplied,
  type BrowserObservationProjection,
  type BrowserViewportDevice
} from '../../shared/browser'
import { createCdpSession, type BrowserDeviceMetrics, type CdpSendResult, type CdpSession } from './cdpSession'
import type {
  BrowserControlActResult,
  BrowserControlCaptureResult,
  BrowserControlFence,
  BrowserControlLoadResult,
  BrowserControlReadResult,
  BrowserPageControl
} from './controlPort'
import {
  DOCUMENT_EXPRESSION,
  READY_EXPRESSION,
  fillExpression,
  focusExpression,
  injectExpression,
  queryExpression,
  scrollExpression,
  selectExpression
} from './controlledScripts'
import type { BrowserGuestContents } from './guestContents'
import { getPlaywrightInjectedScriptSource } from './injectedSource'
import { isEquivalentNavigationUrl, isNavigationAborted } from './navigationGuard'
import { readPngIhdr } from './pngIhdr'

export const BROWSER_COMMAND_DEADLINE_MS = 8_000
export const BROWSER_ABORTED_NAVIGATION_MS = 500

const WORLD_NAME = 'nova-browser'

export interface ElectronBrowserDriverOptions {
  readonly idleMs?: number
  readonly commandDeadlineMs?: number
  readonly abortedNavigationMs?: number
  readonly now?: () => number
}

interface GuestState {
  readonly session: CdpSession
  world: { epoch: number; contextId: number } | null
  readonly onDialog: (method: string, params: unknown) => void
  metrics: BrowserDeviceMetrics | null
  device: BrowserViewportDevice
}

interface QueryHit {
  readonly count: number
  readonly x?: number
  readonly y?: number
  readonly width?: number
  readonly height?: number
  readonly error?: string
}

export function createElectronBrowserDriver(
  options: ElectronBrowserDriverOptions = {}
): BrowserPageControl {
  const deadlineMs = options.commandDeadlineMs ?? BROWSER_COMMAND_DEADLINE_MS
  const abortedMs = options.abortedNavigationMs ?? BROWSER_ABORTED_NAVIGATION_MS
  const now = options.now ?? Date.now
  const guests = new Map<number, GuestState>()
  const refs = new Map<string, Readonly<Record<string, string>>>()

  function stateFor(guest: BrowserGuestContents): GuestState {
    const existing = guests.get(guest.id)
    if (existing) return existing
    const session = createCdpSession(guest.debugger, { idleMs: options.idleMs })
    const onDialog = (method: string, params: unknown): void => {
      if (method !== 'Page.javascriptDialogOpening') return
      if (!guest.debugger.isAttached()) return
      const type = isRecord(params) && typeof params.type === 'string' ? params.type : 'alert'
      const accept = type === 'alert'
      void guest.debugger.sendCommand('Page.handleJavaScriptDialog', { accept }).catch(() => undefined)
    }
    guest.debugger.on('message', onDialog)
    const created: GuestState = {
      session,
      world: null,
      onDialog,
      metrics: null,
      device: 'desktop'
    }
    guests.set(guest.id, created)
    return created
  }

  function evaluate(
    state: GuestState,
    fence: BrowserControlFence,
    expression: string,
    deadlineAt: number
  ): Promise<{ ok: true; value: unknown } | { ok: false; failure: BrowserNotApplied }> {
    return runInWorld(state, fence, expression, deadlineAt)
  }

  async function rememberViewport(
    state: GuestState,
    fence: BrowserControlFence,
    width: number,
    height: number,
    device: BrowserViewportDevice,
    deadlineAt: number
  ): Promise<CdpSendResult | null> {
    if (width < 1 || height < 1) return null
    const metrics: BrowserDeviceMetrics = {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: device === 'mobile',
      dontSetVisibleSize: true
    }
    state.metrics = metrics
    state.device = device
    state.session.setDeviceMetrics(metrics)
    if (!state.session.isExternallyDetached()) {
      return state.session.send(
        'Emulation.setDeviceMetricsOverride',
        { ...metrics },
        fence,
        remaining(deadlineAt, now)
      )
    }
    return null
  }

  return {
    async observe(guest, fence) {
      return guard(async () => {
        const closed = closedGuest(guest)
        if (closed) return closed
        const state = stateFor(guest)
        const deadlineAt = now() + deadlineMs
        const read = await evaluate(state, fence, DOCUMENT_EXPRESSION, deadlineAt)
        if (!read.ok) return read.failure
        const document = readDocument(read.value, state.device)
        if (!document) return browserNotApplied('unavailable', '主 frame 文档无法读取')
        const synced = await rememberViewport(
          state,
          fence,
          document.snapshot.viewport.width,
          document.snapshot.viewport.height,
          state.device,
          deadlineAt
        )
        if (synced && !synced.ok) return synced.failure
        const current = fence.stillCurrent()
        if (!current.ok) return browserNotApplied(current.code, '观察结果已过期')
        return { status: 'applied', read: document }
      })
    },

    async act(guest, fence, action) {
      return guardAct(async () => {
        const closed = closedGuest(guest)
        if (closed) return closed
        const state = stateFor(guest)
        const deadlineAt = now() + deadlineMs
        if (action.kind === 'scroll') return scroll(state, fence, action, deadlineAt)
        if (action.kind === 'viewport') return viewport(state, fence, action, deadlineAt)
        const selector = fence.observationId ? refs.get(fence.observationId)?.[action.ref] : undefined
        if (!selector) return browserNotApplied('target_missing', '找不到该引用，需要重新观察')
        if (action.kind === 'click') return click(state, fence, selector, deadlineAt)
        if (action.kind === 'fill') return fill(state, fence, selector, action.text, deadlineAt)
        if (action.kind === 'select') return select(state, fence, selector, action.values, deadlineAt)
        return press(state, fence, selector, action.key, deadlineAt)
      })
    },

    async capture(guest, fence) {
      return guardCapture(async () => {
        const closed = closedGuest(guest)
        if (closed) return closed
        const state = stateFor(guest)
        const deadlineAt = now() + deadlineMs
        const read = await evaluate(
          state,
          fence,
          `(() => ({ width: Math.round(window.innerWidth || 0), height: Math.round(window.innerHeight || 0) }))()`,
          deadlineAt
        )
        if (!read.ok) return read.failure
        const clip = readClip(read.value)
        const shot = await shoot(guest, clip)
        if (!shot) return browserNotApplied('capture_not_ready', '截图不是有效的 PNG')
        const current = fence.stillCurrent()
        if (!current.ok) return browserNotApplied(current.code, '截图结果已过期')
        return { status: 'applied', width: shot.width, height: shot.height, base64: shot.base64 }
      })
    },

    async load(guest, fence, url) {
      return guardLoad(async () => {
        const closed = closedGuest(guest)
        if (closed) return closed
        const state = stateFor(guest)
        state.world = null
        const deadlineAt = now() + deadlineMs
        const previous = safeUrl(guest)
        try {
          await guest.loadURL(url)
        } catch (error) {
          if (!isNavigationAborted(error)) {
            const message = error instanceof Error ? error.message : '导航失败'
            return browserNotApplied('navigation_failed', message)
          }
          const committed = await confirmAborted(state, guest, fence, url, previous, now() + abortedMs, now)
          if (committed !== true) return committed
          return { status: 'applied' }
        }
        const ready = await waitForDocument(state, guest, fence, url, deadlineAt, now)
        if (ready !== true) return ready
        return { status: 'applied' }
      })
    },

    bindRefs(observationId, next) {
      refs.set(observationId, next)
      while (refs.size > 32) {
        const oldest = refs.keys().next().value
        if (oldest === undefined) break
        refs.delete(oldest)
      }
    },

    release(guest) {
      if (!guest) return
      const state = guests.get(guest.id)
      if (!state) return
      try {
        guest.debugger.off('message', state.onDialog)
      } catch {
        // guest 可能已销毁
      }
      state.session.release()
      guests.delete(guest.id)
    }
  }
}

function remaining(deadlineAt: number, now: () => number): number {
  return Math.max(0, deadlineAt - now())
}

function closedGuest(guest: BrowserGuestContents): BrowserNotApplied | null {
  try {
    if (guest.isDestroyed()) return browserNotApplied('page_closed', '页面已关闭')
  } catch {
    return browserNotApplied('page_closed', '页面已关闭')
  }
  return null
}

function safeUrl(guest: BrowserGuestContents): string {
  try {
    return guest.getURL()
  } catch {
    return ''
  }
}

async function scroll(
  state: GuestState,
  fence: BrowserControlFence,
  action: Extract<BrowserAction, { kind: 'scroll' }>,
  deadlineAt: number
): Promise<BrowserControlActResult> {
  const read = await runInWorld(state, fence, scrollExpression(action.direction, action.amount), deadlineAt)
  if (!read.ok) return read.failure
  if (!isRecord(read.value) || typeof read.value.before !== 'number' || typeof read.value.after !== 'number') {
    return browserNotApplied('unavailable', '无法读取滚动位置')
  }
  if (read.value.after === read.value.before) {
    return browserNotApplied('unavailable', `滚动未生效，scrollY 仍为 ${read.value.after}`)
  }
  return { status: 'applied', summary: `页面已滚动，scrollY ${read.value.before} → ${read.value.after}` }
}

async function viewport(
  state: GuestState,
  fence: BrowserControlFence,
  action: Extract<BrowserAction, { kind: 'viewport' }>,
  deadlineAt: number
): Promise<BrowserControlActResult> {
  const metrics: BrowserDeviceMetrics = {
    width: action.width,
    height: action.height,
    deviceScaleFactor: 1,
    mobile: action.device === 'mobile',
    dontSetVisibleSize: true
  }
  state.metrics = metrics
  state.device = action.device
  state.session.setDeviceMetrics(metrics)
  const sent = await state.session.send(
    'Emulation.setDeviceMetricsOverride',
    { ...metrics },
    fence,
    Math.max(0, deadlineAt - Date.now())
  )
  if (!sent.ok) return sent.failure
  return { status: 'applied', summary: `视口已设为 ${action.width}×${action.height}` }
}

async function click(
  state: GuestState,
  fence: BrowserControlFence,
  selector: string,
  deadlineAt: number
): Promise<BrowserControlActResult> {
  const hit = await locate(state, fence, selector, deadlineAt)
  if ('failure' in hit) return hit.failure
  if (hit.count === 0) return browserNotApplied('target_missing', '目标已不在页面上')
  if (hit.count !== 1) return browserNotApplied('target_ambiguous', '目标不唯一')
  if (
    typeof hit.x !== 'number'
    || typeof hit.y !== 'number'
    || typeof hit.width !== 'number'
    || typeof hit.height !== 'number'
    || hit.width < 1
    || hit.height < 1
  ) {
    return browserNotApplied('target_missing', '目标没有可点击的区域')
  }
  const point = { x: Math.round(hit.x), y: Math.round(hit.y) }
  const moved = await state.session.send(
    'Input.dispatchMouseEvent',
    { type: 'mouseMoved', ...point },
    fence,
    Math.max(0, deadlineAt - Date.now())
  )
  if (!moved.ok) return moved.failure
  const pressed = await state.session.send(
    'Input.dispatchMouseEvent',
    { type: 'mousePressed', button: 'left', clickCount: 1, ...point },
    fence,
    Math.max(0, deadlineAt - Date.now())
  )
  if (!pressed.ok) return unknownIfSent(pressed.failure)
  const released = await state.session.send(
    'Input.dispatchMouseEvent',
    { type: 'mouseReleased', button: 'left', clickCount: 1, ...point },
    fence,
    Math.max(0, deadlineAt - Date.now())
  )
  if (!released.ok) return unknownIfSent(released.failure)
  return { status: 'applied', summary: '已点击目标' }
}

async function fill(
  state: GuestState,
  fence: BrowserControlFence,
  selector: string,
  text: string,
  deadlineAt: number
): Promise<BrowserControlActResult> {
  const read = await runInWorld(state, fence, fillExpression(selector, text), deadlineAt)
  if (!read.ok) return read.failure
  return appliedCount(read.value, '已填入文本')
}

async function select(
  state: GuestState,
  fence: BrowserControlFence,
  selector: string,
  values: readonly string[],
  deadlineAt: number
): Promise<BrowserControlActResult> {
  const read = await runInWorld(state, fence, selectExpression(selector, values), deadlineAt)
  if (!read.ok) return read.failure
  if (isRecord(read.value) && read.value.error === 'not-select') {
    return browserNotApplied('unsupported', '目标不是选择框')
  }
  if (isRecord(read.value) && read.value.error === 'no-option') {
    return browserNotApplied('target_missing', '选项不存在')
  }
  return appliedCount(read.value, '已选择选项')
}

async function press(
  state: GuestState,
  fence: BrowserControlFence,
  selector: string,
  key: string,
  deadlineAt: number
): Promise<BrowserControlActResult> {
  const descriptor = keyDescriptor(key)
  if (!descriptor) return browserNotApplied('unsupported', '不支持该按键')
  const focused = await runInWorld(state, fence, focusExpression(selector), deadlineAt)
  if (!focused.ok) return focused.failure
  const focusResult = appliedCount(focused.value, '已聚焦')
  if (focusResult.status !== 'applied') return focusResult
  const down = await state.session.send(
    'Input.dispatchKeyEvent',
    { type: 'keyDown', ...descriptor },
    fence,
    Math.max(0, deadlineAt - Date.now())
  )
  if (!down.ok) return unknownIfSent(down.failure)
  const up = await state.session.send(
    'Input.dispatchKeyEvent',
    { type: 'keyUp', key: descriptor.key, code: descriptor.code, windowsVirtualKeyCode: descriptor.windowsVirtualKeyCode },
    fence,
    Math.max(0, deadlineAt - Date.now())
  )
  if (!up.ok) return unknownIfSent(up.failure)
  return { status: 'applied', summary: `已按下 ${key}` }
}

async function locate(
  state: GuestState,
  fence: BrowserControlFence,
  selector: string,
  deadlineAt: number
): Promise<QueryHit | { failure: BrowserNotApplied }> {
  const read = await runInWorld(state, fence, queryExpression(selector), deadlineAt)
  if (!read.ok) return { failure: read.failure }
  if (!isRecord(read.value) || typeof read.value.count !== 'number') {
    return { failure: browserNotApplied('unavailable', '无法定位目标') }
  }
  if (read.value.error === 'missing-engine') {
    return { failure: browserNotApplied('unavailable', '隔离世界缺少定位脚本') }
  }
  return {
    count: read.value.count,
    x: typeof read.value.x === 'number' ? read.value.x : undefined,
    y: typeof read.value.y === 'number' ? read.value.y : undefined,
    width: typeof read.value.width === 'number' ? read.value.width : undefined,
    height: typeof read.value.height === 'number' ? read.value.height : undefined
  }
}

async function runInWorld(
  state: GuestState,
  fence: BrowserControlFence,
  expression: string,
  deadlineAt: number,
  allowRetry = true
): Promise<{ ok: true; value: unknown } | { ok: false; failure: BrowserNotApplied }> {
  const epoch = state.session.connectionEpoch()
  if (!state.world || state.world.epoch !== epoch) {
    const opened = await openWorld(state, fence, deadlineAt)
    if (!opened.ok) return opened
  }
  const context = state.world
  if (!context) return { ok: false, failure: browserNotApplied('unavailable', '隔离世界没有创建') }
  const sent = await state.session.send(
    'Runtime.evaluate',
    {
      expression,
      contextId: context.contextId,
      awaitPromise: true,
      returnByValue: true
    },
    fence,
    Math.max(0, deadlineAt - Date.now())
  )
  if (!sent.ok) return sent
  const parsed = readEvaluation(sent.value)
  if (!parsed.ok) {
    state.world = null
    if (allowRetry) return runInWorld(state, fence, expression, deadlineAt, false)
    return { ok: false, failure: browserNotApplied('unavailable', parsed.detail) }
  }
  return { ok: true, value: parsed.value }
}

async function openWorld(
  state: GuestState,
  fence: BrowserControlFence,
  deadlineAt: number
): Promise<{ ok: true } | { ok: false; failure: BrowserNotApplied }> {
  const tree = await state.session.send(
    'Page.getFrameTree',
    undefined,
    fence,
    Math.max(0, deadlineAt - Date.now())
  )
  if (!tree.ok) return tree
  const frameId = readFrameId(tree.value)
  if (!frameId) return { ok: false, failure: browserNotApplied('unavailable', '找不到主 frame') }
  const created = await state.session.send(
    'Page.createIsolatedWorld',
    { frameId, grantUniveralAccess: false, worldName: WORLD_NAME },
    fence,
    Math.max(0, deadlineAt - Date.now())
  )
  if (!created.ok) return created
  const contextId = readContextId(created.value)
  if (contextId === null) return { ok: false, failure: browserNotApplied('unavailable', '隔离世界没有创建') }
  const injected = await state.session.send(
    'Runtime.evaluate',
    {
      expression: sharedInjection(),
      contextId,
      awaitPromise: true,
      returnByValue: true
    },
    fence,
    Math.max(0, deadlineAt - Date.now())
  )
  if (!injected.ok) return injected
  const parsed = readEvaluation(injected.value)
  if (!parsed.ok || parsed.value !== true) {
    return { ok: false, failure: browserNotApplied('unavailable', '隔离世界注入失败') }
  }
  state.world = { epoch: state.session.connectionEpoch(), contextId }
  return { ok: true }
}

let cachedInjection: string | undefined

function sharedInjection(): string {
  if (!cachedInjection) cachedInjection = injectExpression(getPlaywrightInjectedScriptSource())
  return cachedInjection
}

function appliedCount(value: unknown, summary: string): BrowserControlActResult {
  if (!isRecord(value)) return browserNotApplied('unavailable', '页面没有返回结果')
  if (value.error === 'missing-engine') return browserNotApplied('unavailable', '隔离世界缺少定位脚本')
  if (value.count === 0) return browserNotApplied('target_missing', '目标已不在页面上')
  if (typeof value.count === 'number' && value.count !== 1) {
    return browserNotApplied('target_ambiguous', '目标不唯一')
  }
  return { status: 'applied', summary }
}

function unknownIfSent(failure: BrowserNotApplied): BrowserControlActResult {
  if (
    failure.code === 'cancelled'
    || failure.code === 'timeout'
    || failure.code === 'taken_over'
    || failure.code === 'stale_observation'
    || failure.code === 'debugger_detached'
  ) {
    return { status: 'outcome_unknown', detail: '输入已经发出，但不能确认是否落到当前页面' }
  }
  return failure
}

async function shoot(
  guest: BrowserGuestContents,
  clip: { width: number; height: number } | null
): Promise<{ width: number; height: number; base64: string } | null> {
  const rect = clip && clip.width > 0 && clip.height > 0
    ? { x: 0, y: 0, width: clip.width, height: clip.height }
    : undefined
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const image = await guest.capturePage(rect)
      const png = image.toPNG()
      const size = readPngIhdr(png)
      if (!size) continue
      return { width: size.width, height: size.height, base64: png.toString('base64') }
    } catch {
      // 再抓一次；仍然失败则交给调用方返回未就绪
    }
  }
  return null
}

async function confirmAborted(
  state: GuestState,
  guest: BrowserGuestContents,
  fence: BrowserControlFence,
  url: string,
  previous: string,
  deadlineAt: number,
  now: () => number
): Promise<true | BrowserNotApplied> {
  while (now() <= deadlineAt) {
    const blocked = fence.stillCurrent()
    if (!blocked.ok) return browserNotApplied(blocked.code, '导航结果已过期')
    if (fence.signal?.aborted) return browserNotApplied('cancelled', '命令已取消')
    const read = await runInWorld(state, fence, READY_EXPRESSION, deadlineAt)
    if (read.ok && isRecord(read.value)) {
      const href = typeof read.value.href === 'string' ? read.value.href : ''
      const readyState = read.value.readyState
      const current = safeUrl(guest)
      if (
        current !== previous
        && href === current
        && (readyState === 'interactive' || readyState === 'complete')
        && isEquivalentNavigationUrl(url, current)
      ) {
        return true
      }
    }
    await delay(50)
  }
  return browserNotApplied('navigation_failed', '导航被中断，页面没有进入目标地址')
}

async function waitForDocument(
  state: GuestState,
  guest: BrowserGuestContents,
  fence: BrowserControlFence,
  url: string,
  deadlineAt: number,
  now: () => number
): Promise<true | BrowserNotApplied> {
  while (now() <= deadlineAt) {
    const blocked = fence.stillCurrent()
    if (!blocked.ok) return browserNotApplied(blocked.code, '导航结果已过期')
    if (fence.signal?.aborted) return browserNotApplied('cancelled', '命令已取消')
    const read = await runInWorld(state, fence, READY_EXPRESSION, deadlineAt)
    if (read.ok && isRecord(read.value)) {
      const href = typeof read.value.href === 'string' ? read.value.href : ''
      const readyState = read.value.readyState
      const current = safeUrl(guest)
      if (
        (readyState === 'interactive' || readyState === 'complete')
        && href === current
        && isEquivalentNavigationUrl(url, current)
      ) {
        return true
      }
    } else if (!read.ok && read.failure.code !== 'timeout') {
      if (read.failure.code === 'cancelled' || read.failure.code === 'taken_over' || read.failure.code === 'debugger_detached') {
        return read.failure
      }
    }
    await delay(50)
  }
  return browserNotApplied('timeout', '页面没有在时限内就绪')
}

function readDocument(
  value: unknown,
  device: BrowserViewportDevice
): { snapshot: BrowserObservationProjection; refs: Record<string, string> } | null {
  if (!isRecord(value)) return null
  if (typeof value.url !== 'string' || typeof value.title !== 'string' || typeof value.summary !== 'string') {
    return null
  }
  const viewport = value.viewport
  if (!isRecord(viewport) || typeof viewport.width !== 'number' || typeof viewport.height !== 'number') {
    return null
  }
  const refs: Record<string, string> = {}
  const interactive: BrowserInteractiveItem[] = []
  if (Array.isArray(value.interactive)) {
    for (const item of value.interactive) {
      if (!isRecord(item)) continue
      if (typeof item.ref !== 'string' || typeof item.role !== 'string' || typeof item.name !== 'string') continue
      if (typeof item.selector !== 'string' || item.selector.length === 0) continue
      refs[item.ref] = item.selector
      interactive.push({ ref: item.ref, role: item.role, name: item.name })
    }
  }
  return {
    snapshot: {
      url: value.url,
      title: value.title,
      summary: value.summary,
      truncated: value.truncated === true,
      viewport: {
        width: viewport.width,
        height: viewport.height,
        device
      },
      interactive
    },
    refs
  }
}

function readClip(value: unknown): { width: number; height: number } | null {
  if (!isRecord(value) || typeof value.width !== 'number' || typeof value.height !== 'number') return null
  return { width: value.width, height: value.height }
}

function readFrameId(value: unknown): string | null {
  if (!isRecord(value) || !isRecord(value.frameTree) || !isRecord(value.frameTree.frame)) return null
  return typeof value.frameTree.frame.id === 'string' ? value.frameTree.frame.id : null
}

function readContextId(value: unknown): number | null {
  if (!isRecord(value) || typeof value.executionContextId !== 'number') return null
  return value.executionContextId
}

function readEvaluation(value: unknown): { ok: true; value: unknown } | { ok: false; detail: string } {
  if (!isRecord(value)) return { ok: false, detail: '页面脚本没有返回结果' }
  if (isRecord(value.exceptionDetails)) {
    const exception = value.exceptionDetails.exception
    if (isRecord(exception) && typeof exception.description === 'string') {
      return { ok: false, detail: exception.description }
    }
    if (typeof value.exceptionDetails.text === 'string') {
      return { ok: false, detail: value.exceptionDetails.text }
    }
    return { ok: false, detail: '页面脚本失败' }
  }
  if (!isRecord(value.result)) return { ok: true, value: undefined }
  return { ok: true, value: value.result.value }
}

function keyDescriptor(key: string): {
  key: string
  code: string
  windowsVirtualKeyCode: number
  text?: string
} | null {
  const named: Record<string, { key: string; code: string; windowsVirtualKeyCode: number }> = {
    Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 },
    Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
    Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
    Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
    ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
    ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
    ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
    ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 }
  }
  if (named[key]) return named[key]
  if (key.length !== 1) return null
  const upper = key.toUpperCase()
  const code = /[A-Z]/u.test(upper) ? `Key${upper}` : ''
  return {
    key,
    code,
    text: key,
    windowsVirtualKeyCode: upper.charCodeAt(0)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function guard(task: () => Promise<BrowserControlReadResult>): Promise<BrowserControlReadResult> {
  try {
    return await task()
  } catch (error) {
    return browserNotApplied('unavailable', error instanceof Error ? error.message : '观察失败')
  }
}

async function guardAct(task: () => Promise<BrowserControlActResult>): Promise<BrowserControlActResult> {
  try {
    return await task()
  } catch (error) {
    return browserNotApplied('unavailable', error instanceof Error ? error.message : '操作失败')
  }
}

async function guardCapture(task: () => Promise<BrowserControlCaptureResult>): Promise<BrowserControlCaptureResult> {
  try {
    return await task()
  } catch (error) {
    return browserNotApplied('unavailable', error instanceof Error ? error.message : '截图失败')
  }
}

async function guardLoad(task: () => Promise<BrowserControlLoadResult>): Promise<BrowserControlLoadResult> {
  try {
    return await task()
  } catch (error) {
    return browserNotApplied('navigation_failed', error instanceof Error ? error.message : '导航失败')
  }
}
