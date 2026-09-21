/**
 * 内置浏览器页面记录与 guest 生命周期的唯一 Owner。
 * 不执行 CDP 动作；不拥有模型循环或权限规则。
 */
import {
  BROWSER_ENGINE_CAPABILITIES,
  BROWSER_MAX_LIVE_PAGES,
  browserNotApplied,
  createBrowserIdentityLedger,
  parseBrowserHttpUrl,
  type BrowserAttachIpcParams,
  type BrowserAttachResult,
  type BrowserClaimResult,
  type BrowserCloseResult,
  type BrowserGuestMount,
  type BrowserGuestMountSnapshot,
  type BrowserIdentityLedger,
  type BrowserLifecycleStatus,
  type BrowserListResult,
  type BrowserNavigateResult,
  type BrowserOpenResult,
  type BrowserPageProjection,
  type BrowserSurfaceSnapshot,
  type BrowserControlProjection,
  type ActionOutcome,
  type BrowserActCommand,
  type BrowserCaptureCommand,
  type BrowserCaptureResult,
  type BrowserClaimCommand,
  type BrowserCloseCommand,
  type BrowserListCommand,
  type BrowserNavigateCommand,
  type BrowserObserveCommand,
  type BrowserObserveResult,
  type BrowserOpenCommand
} from '../../shared/browser'
import type { BrowserCommandContext, BrowserPort } from '../../runtime/browser'
import { routeGuestPopup } from './webviewPolicy'
import type { BrowserGuestContents } from './guestContents'

export const BROWSER_PENDING_CONVERGE_MS = 1000
export const BROWSER_DESTROY_CONFIRM_MS = 4000
export const BROWSER_ATTACH_TIMEOUT_MS = 15000

const CONTROL_UNAVAILABLE = browserNotApplied('unsupported', '页面观察与操控尚未装配')

export interface BrowserSessionHostDeps {
  readonly resolveWorkspaceKey: (sessionId: string) => string | null
  readonly lookupGuest: (webContentsId: number) => BrowserGuestContents | undefined
  readonly openExternal: (url: string) => void
  readonly delay?: (ms: number) => Promise<void>
  readonly onSnapshot?: (snapshot: BrowserSurfaceSnapshot) => void
  readonly onGuestMount?: (snapshot: BrowserGuestMountSnapshot) => void
  readonly getCurrentSessionId?: () => string | null
  readonly identity?: BrowserIdentityLedger
}

export interface BrowserBindingInspection {
  readonly webContentsId: number | null
  readonly type: string | null
  readonly destroyed: boolean
  readonly debuggerAttached: boolean
  readonly generation: number
  readonly lifecycle: BrowserLifecycleStatus
}

export interface BrowserSessionHost extends BrowserPort {
  attach(params: BrowserAttachIpcParams): Promise<BrowserAttachResult>
  hide(browserId: string, sessionId: string): Promise<BrowserNavigateResult>
  restore(browserId: string, sessionId: string): Promise<BrowserNavigateResult>
  noteRendererReloading(): void
  handlePopup(url: string, sessionId?: string): void
  inspectBinding(browserId: string): BrowserBindingInspection | null
  livePageCount(): number
}

interface PageRecord {
  sessionId: string
  url: string
  title: string
  loading: boolean
  lifecycle: BrowserLifecycleStatus
  control: BrowserControlProjection
  partition: string
  visible: boolean
  guest: BrowserGuestContents | null
  attachWaiters: Array<(result: BrowserAttachResult) => void>
  guestListeners: Array<{
    event: Parameters<BrowserGuestContents['on']>[0]
    listener: (...args: unknown[]) => void
  }>
  serial: Promise<void>
  halted: boolean
}

function defaultDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function partitionFor(browserId: string): string {
  return `nova-browser-${browserId}`
}

export function createBrowserSessionHost(deps: BrowserSessionHostDeps): BrowserSessionHost {
  const ledger = deps.identity ?? createBrowserIdentityLedger()
  const delay = deps.delay ?? defaultDelay
  const pages = new Map<string, PageRecord>()
  let sequence = 0

  function emit(): void {
    sequence += 1
    deps.onSnapshot?.(snapshot())
    deps.onGuestMount?.(guestSnapshot())
  }

  function snapshot(): BrowserSurfaceSnapshot {
    const list: BrowserPageProjection[] = []
    let activeBrowserId: string | null = null
    for (const [browserId, record] of pages) {
      const identity = ledger.inspect(browserId, record.sessionId)
      if (!identity.ok) continue
      list.push(project(identity.value, record))
      if (record.visible && record.lifecycle !== 'closing' && record.lifecycle !== 'failed') {
        activeBrowserId = browserId
      }
    }
    return {
      sequence,
      pages: list,
      activeBrowserId,
      maxLivePages: BROWSER_MAX_LIVE_PAGES
    }
  }

  function guestSnapshot(): BrowserGuestMountSnapshot {
    const guests: BrowserGuestMount[] = []
    for (const [browserId, record] of pages) {
      if (
        record.lifecycle === 'closing'
        || record.lifecycle === 'failed'
        || record.lifecycle === 'crashed'
      ) {
        continue
      }
      const identity = ledger.inspect(browserId, record.sessionId)
      if (!identity.ok) continue
      guests.push({
        browserId,
        generation: identity.value.generation,
        src: record.url,
        partition: record.partition,
        visible: record.visible
      })
    }
    return { sequence, guests }
  }

  function project(
    identity: {
      browserId: string
      generation: number
      documentEpoch: number
      sessionId: string
    },
    record: PageRecord
  ): BrowserPageProjection {
    return {
      browserId: identity.browserId,
      generation: identity.generation,
      documentEpoch: identity.documentEpoch,
      sessionId: identity.sessionId,
      url: record.url,
      title: record.title,
      loading: record.loading,
      lifecycle: record.lifecycle,
      control: record.control,
      capabilities: BROWSER_ENGINE_CAPABILITIES
    }
  }

  function lookupPage(
    browserId: string,
    sessionId: string
  ): { record: PageRecord; page: BrowserPageProjection } | ReturnType<typeof browserNotApplied> {
    const identity = ledger.inspect(browserId, sessionId)
    if (!identity.ok) return browserNotApplied(identity.code, '页面不属于当前会话或已关闭')
    const record = pages.get(browserId)
    if (!record) return browserNotApplied('page_closed', '页面记录已不存在')
    if (record.halted && record.lifecycle === 'crashed') {
      return browserNotApplied('page_crashed', '页面已崩溃')
    }
    if (record.lifecycle === 'closing') {
      return browserNotApplied('page_closed', '页面正在关闭')
    }
    return { record, page: project(identity.value, record) }
  }

  function runSerial<T>(record: PageRecord, task: () => Promise<T>): Promise<T> {
    const next = record.serial.then(task, task)
    record.serial = next.then(
      () => undefined,
      () => undefined
    )
    return next
  }

  function unbindGuest(record: PageRecord): void {
    const guest = record.guest
    if (!guest) return
    for (const { event, listener } of record.guestListeners) {
      try {
        guest.off(event, listener)
      } catch {
        // guest 可能已销毁
      }
    }
    record.guestListeners = []
    record.guest = null
  }

  function listen(
    record: PageRecord,
    guest: BrowserGuestContents,
    event: Parameters<BrowserGuestContents['on']>[0],
    listener: (...args: unknown[]) => void
  ): void {
    guest.on(event, listener)
    record.guestListeners.push({ event, listener })
  }

  function failAttachWaiters(record: PageRecord, result: BrowserAttachResult): void {
    const waiters = record.attachWaiters.splice(0)
    for (const waiter of waiters) waiter(result)
  }

  async function convergePending(_record: PageRecord): Promise<void> {
    await delay(BROWSER_PENDING_CONVERGE_MS)
  }

  function detachDebugger(guest: BrowserGuestContents | null): boolean {
    if (!guest) return true
    try {
      if (guest.isDestroyed()) return true
      if (!guest.debugger.isAttached()) return true
      guest.debugger.detach()
      return !guest.debugger.isAttached()
    } catch {
      return true
    }
  }

  async function waitDestroyed(guest: BrowserGuestContents | null): Promise<boolean> {
    if (!guest) return true
    try {
      if (guest.isDestroyed()) return true
    } catch {
      return true
    }
    return Promise.race([
      new Promise<boolean>((resolve) => {
        const onDestroyed = (): void => resolve(true)
        guest.on('destroyed', onDestroyed)
      }),
      delay(BROWSER_DESTROY_CONFIRM_MS).then(() => {
        try {
          return guest.isDestroyed()
        } catch {
          return true
        }
      })
    ])
  }

  function bindGuest(
    browserId: string,
    record: PageRecord,
    guest: BrowserGuestContents,
    sessionId: string
  ): void {
    unbindGuest(record)
    record.guest = guest
    guest.setWindowOpenHandler((details) => {
      handlePopup(details.url, sessionId)
      return { action: 'deny' }
    })
    listen(record, guest, 'will-navigate', (...args: unknown[]) => {
      const event = args[0] as { preventDefault?: () => void }
      const url = typeof args[1] === 'string' ? args[1] : ''
      if (parseBrowserHttpUrl(url) === null) event.preventDefault?.()
    })
    listen(record, guest, 'did-start-loading', () => {
      record.loading = true
      emit()
    })
    listen(record, guest, 'did-stop-loading', () => {
      try {
        record.loading = guest.isLoading()
        record.url = guest.getURL() || record.url
        record.title = guest.getTitle() || record.title
      } catch {
        record.loading = false
      }
      emit()
    })
    listen(record, guest, 'did-navigate', () => {
      try {
        record.url = guest.getURL() || record.url
      } catch {
        // ignore
      }
      ledger.bumpDocumentEpoch(browserId)
      emit()
    })
    listen(record, guest, 'page-title-updated', (...args: unknown[]) => {
      if (typeof args[0] === 'string') record.title = args[0]
      else if (typeof args[1] === 'string') record.title = args[1]
      emit()
    })
    listen(record, guest, 'destroyed', () => {
      if (record.lifecycle === 'closing') return
      unbindGuest(record)
      if (record.lifecycle !== 'crashed') record.lifecycle = 'opening'
      emit()
    })
    listen(record, guest, 'render-process-gone', () => {
      void handleCrash(browserId)
    })
  }

  async function handleCrash(browserId: string): Promise<void> {
    const record = pages.get(browserId)
    if (!record || record.lifecycle === 'closing') return
    record.halted = true
    record.lifecycle = 'crashed'
    record.loading = false
    emit()
    await convergePending(record)
    if (!detachDebugger(record.guest)) {
      emit()
      return
    }
    ledger.bumpGeneration(browserId)
    emit()
  }

  function handlePopup(url: string, sessionId?: string): void {
    const owner = sessionId && sessionId.length > 0 ? sessionId : deps.getCurrentSessionId?.() ?? null
    const decision = routeGuestPopup(url, livePageCount())
    if (decision.openInternal) {
      if (owner === null) return
      void open({ url: decision.openInternal }, { sessionId: owner })
    } else if (decision.openExternal) {
      deps.openExternal(decision.openExternal)
    }
  }

  function livePageCount(): number {
    let live = 0
    for (const record of pages.values()) {
      if (record.lifecycle !== 'closing' && record.lifecycle !== 'failed') live += 1
    }
    return live
  }

  async function open(command: BrowserOpenCommand, context: BrowserCommandContext): Promise<BrowserOpenResult> {
    const workspaceKey = deps.resolveWorkspaceKey(context.sessionId)
    if (workspaceKey === null) {
      return browserNotApplied('not_owner', '当前会话没有可绑定的工作区')
    }
    const url = parseBrowserHttpUrl(command.url)
    if (url === null) {
      return browserNotApplied('invalid_request', '只允许不含用户信息的 http 或 https 地址')
    }
    const issued = ledger.issuePage({ sessionId: context.sessionId, workspaceKey })
    if (!issued.ok) {
      return browserNotApplied(issued.code, '无法打开新的浏览器页面')
    }
    const record: PageRecord = {
      sessionId: context.sessionId,
      url,
      title: '',
      loading: true,
      lifecycle: 'opening',
      control: { holder: 'user' },
      partition: partitionFor(issued.value.browserId),
      visible: true,
      guest: null,
      attachWaiters: [],
      guestListeners: [],
      serial: Promise.resolve(),
      halted: false
    }
    pages.set(issued.value.browserId, record)
    emit()
    const attached = new Promise<BrowserAttachResult>((resolve) => {
      record.attachWaiters.push(resolve)
    })
    return Promise.race([
      attached,
      delay(BROWSER_ATTACH_TIMEOUT_MS).then((): BrowserAttachResult => {
        if (record.lifecycle === 'opening' && record.guest === null) {
          record.lifecycle = 'failed'
          const timeout = browserNotApplied('timeout', '页面未能在时限内挂载')
          failAttachWaiters(record, timeout)
          emit()
          return timeout
        }
        return browserNotApplied('timeout', '页面未能在时限内挂载')
      })
    ])
  }

  async function attach(params: BrowserAttachIpcParams): Promise<BrowserAttachResult> {
    const found = lookupPage(params.browserId, params.sessionId)
    if ('status' in found) return found
    return runSerial(found.record, async () => {
      const guest = deps.lookupGuest(params.webContentsId)
      if (!guest) {
        return browserNotApplied('unavailable', '找不到对应的页面进程')
      }
      try {
        if (guest.isDestroyed()) {
          return browserNotApplied('unavailable', '页面进程已销毁')
        }
      } catch {
        return browserNotApplied('unavailable', '页面进程已销毁')
      }
      let type: string
      try {
        type = guest.getType()
      } catch {
        return browserNotApplied('unavailable', '无法读取页面类型')
      }
      if (type !== 'webview') {
        return browserNotApplied('unavailable', '拒绝非 webview 页面进程')
      }
      const boundTo = findOwnerByGuestId(guest.id)
      if (boundTo !== undefined && boundTo !== params.browserId) {
        return browserNotApplied('unavailable', '该页面进程已绑定其它标签')
      }
      if (found.record.guest && found.record.guest.id === guest.id) {
        return finishAttach(params.browserId, params.sessionId, found.record)
      }
      if (found.record.guest && !safeDestroyed(found.record.guest)) {
        return browserNotApplied('unavailable', '旧页面进程仍在，拒绝抢绑')
      }
      bindGuest(params.browserId, found.record, guest, params.sessionId)
      found.record.loading = safeLoading(guest)
      try {
        found.record.url = guest.getURL() || found.record.url
        found.record.title = guest.getTitle() || found.record.title
      } catch {
        // ignore
      }
      return finishAttach(params.browserId, params.sessionId, found.record)
    })
  }

  function findOwnerByGuestId(webContentsId: number): string | undefined {
    for (const [browserId, record] of pages) {
      if (record.guest?.id === webContentsId) return browserId
    }
    return undefined
  }

  function finishAttach(
    browserId: string,
    sessionId: string,
    record: PageRecord
  ): BrowserAttachResult {
    record.lifecycle = record.visible ? 'ready' : 'hidden'
    const identity = ledger.inspect(browserId, sessionId)
    if (!identity.ok) return browserNotApplied(identity.code, '页面不属于当前会话或已关闭')
    const applied = { status: 'applied' as const, page: project(identity.value, record) }
    failAttachWaiters(record, applied)
    emit()
    return applied
  }

  function safeDestroyed(guest: BrowserGuestContents): boolean {
    try {
      return guest.isDestroyed()
    } catch {
      return true
    }
  }

  function safeLoading(guest: BrowserGuestContents): boolean {
    try {
      return guest.isLoading()
    } catch {
      return false
    }
  }

  async function navigate(
    command: BrowserNavigateCommand,
    context: BrowserCommandContext
  ): Promise<BrowserNavigateResult> {
    const found = lookupPage(command.browserId, context.sessionId)
    if ('status' in found) return found
    return runSerial(found.record, async () => {
      const guest = found.record.guest
      if (!guest || safeDestroyed(guest)) {
        return browserNotApplied('unavailable', '页面尚未挂载')
      }
      try {
        const action = command.action
        if (action.kind === 'url') {
          found.record.url = action.url
          found.record.loading = true
          emit()
          await guest.loadURL(action.url)
        } else if (action.kind === 'back') guest.goBack()
        else if (action.kind === 'forward') guest.goForward()
        else if (action.kind === 'reload') guest.reload()
        else guest.stop()
      } catch (error) {
        return browserNotApplied(
          'navigation_failed',
          error instanceof Error ? error.message : '导航失败'
        )
      }
      const identity = ledger.inspect(command.browserId, context.sessionId)
      if (!identity.ok) return browserNotApplied(identity.code, '页面不属于当前会话或已关闭')
      return { status: 'applied', page: project(identity.value, found.record) }
    })
  }

  async function close(
    command: BrowserCloseCommand,
    context: BrowserCommandContext
  ): Promise<BrowserCloseResult> {
    const identity = ledger.inspect(command.browserId, context.sessionId)
    if (!identity.ok) return browserNotApplied(identity.code, '页面不属于当前会话或已关闭')
    const record = pages.get(command.browserId)
    if (!record) return browserNotApplied('page_closed', '页面记录已不存在')
    return runSerial(record, async () => {
      record.lifecycle = 'closing'
      record.visible = false
      record.halted = true
      emit()
      await convergePending(record)
      if (!detachDebugger(record.guest)) {
        return { status: 'outcome_unknown' as const, detail: '调试会话未能确认释放，拒绝换代关闭' }
      }
      const guest = record.guest
      unbindGuest(record)
      emit()
      if (!(await waitDestroyed(guest))) {
        return { status: 'outcome_unknown' as const, detail: '页面进程尚未销毁，拒绝当作已关闭' }
      }
      ledger.retire(command.browserId)
      pages.delete(command.browserId)
      emit()
      return { status: 'applied', browserId: command.browserId }
    })
  }

  async function setVisible(
    browserId: string,
    sessionId: string,
    visible: boolean
  ): Promise<BrowserNavigateResult> {
    const found = lookupPage(browserId, sessionId)
    if ('status' in found) return found
    return runSerial(found.record, async () => {
      if (found.record.lifecycle === 'crashed' || found.record.lifecycle === 'failed') {
        return browserNotApplied('page_crashed', '当前页面不能恢复显示')
      }
      found.record.visible = visible
      if (found.record.guest) {
        found.record.lifecycle = visible ? 'ready' : 'hidden'
      }
      const identity = ledger.inspect(browserId, sessionId)
      if (!identity.ok) return browserNotApplied(identity.code, '页面不属于当前会话或已关闭')
      emit()
      return { status: 'applied', page: project(identity.value, found.record) }
    })
  }

  async function claim(
    command: BrowserClaimCommand,
    context: BrowserCommandContext
  ): Promise<BrowserClaimResult> {
    const found = lookupPage(command.browserId, context.sessionId)
    if ('status' in found) return found
    const bumped = ledger.bumpGeneration(command.browserId)
    if (!bumped.ok) return browserNotApplied(bumped.code, '无法接管该页面')
    found.record.control = { holder: 'user' }
    emit()
    return { status: 'applied', page: project(bumped.value, found.record) }
  }

  async function release(
    command: BrowserClaimCommand,
    context: BrowserCommandContext
  ): Promise<BrowserClaimResult> {
    const found = lookupPage(command.browserId, context.sessionId)
    if ('status' in found) return found
    found.record.control = { holder: 'none' }
    const identity = ledger.inspect(command.browserId, context.sessionId)
    if (!identity.ok) return browserNotApplied(identity.code, '页面不属于当前会话或已关闭')
    emit()
    return { status: 'applied', page: project(identity.value, found.record) }
  }

  function listPages(
    command: BrowserListCommand,
    context: BrowserCommandContext
  ): Promise<BrowserListResult> {
    if (command.sessionId !== context.sessionId) {
      return Promise.resolve(browserNotApplied('not_owner', '不能读取其它会话的页面'))
    }
    emit()
    return Promise.resolve({ status: 'applied', snapshot: snapshot() })
  }

  function noteRendererReloading(): void {
    for (const record of pages.values()) {
      if (record.lifecycle === 'closing' || record.lifecycle === 'failed') continue
      unbindGuest(record)
      if (record.lifecycle === 'ready' || record.lifecycle === 'hidden' || record.lifecycle === 'crashed') {
        record.lifecycle = record.lifecycle === 'crashed' ? 'crashed' : 'opening'
      }
      failAttachWaiters(record, browserNotApplied('unavailable', '界面已重新加载，等待重新挂载'))
    }
    emit()
  }

  function inspectBinding(browserId: string): BrowserBindingInspection | null {
    const record = pages.get(browserId)
    if (!record) return null
    const identity = ledger.inspect(browserId, record.sessionId)
    let type: string | null = null
    let destroyed = true
    let debuggerAttached = false
    if (record.guest) {
      try {
        type = record.guest.getType()
        destroyed = record.guest.isDestroyed()
        debuggerAttached = record.guest.debugger.isAttached()
      } catch {
        destroyed = true
      }
    }
    return {
      webContentsId: record.guest?.id ?? null,
      type,
      destroyed: record.guest ? destroyed : true,
      debuggerAttached,
      generation: identity.ok ? identity.value.generation : 0,
      lifecycle: record.lifecycle
    }
  }

  return {
    open,
    navigate,
    observe: async (_command: BrowserObserveCommand): Promise<BrowserObserveResult> => CONTROL_UNAVAILABLE,
    act: async (_command: BrowserActCommand): Promise<ActionOutcome> => CONTROL_UNAVAILABLE,
    capture: async (_command: BrowserCaptureCommand): Promise<BrowserCaptureResult> => CONTROL_UNAVAILABLE,
    close,
    listPages,
    claim,
    release,
    attach,
    hide: (browserId, sessionId) => setVisible(browserId, sessionId, false),
    restore: (browserId, sessionId) => setVisible(browserId, sessionId, true),
    noteRendererReloading,
    handlePopup,
    inspectBinding,
    livePageCount
  }
}
