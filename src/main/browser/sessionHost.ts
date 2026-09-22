/**
 * 内置浏览器页面记录与 guest 生命周期的唯一 Owner。
 * CDP 与隔离世界交给 BrowserPageControl；这里不实现协议。
 */
import {
  BROWSER_MAX_LIVE_PAGES,
  BROWSER_PAGE_CAP_MESSAGE,
  BROWSER_PENDING_MAX,
  browserNotApplied,
  createBrowserIdentityLedger,
  parseBrowserHttpUrl,
  projectBrowserPage,
  projectFaviconUrl,
  projectGuestLoadError,
  readGuestFaviconArgs,
  readGuestLoadFailureArgs,
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
  type BrowserGuestNotice,
  type BrowserPageLoadError,
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
import type { BrowserControlFence, BrowserPageControl } from './controlPort'
import { createPreviewGrantStore, type PreviewGrantStore } from './previewGrants'
import { routeGuestPopup } from './webviewPolicy'
import type { BrowserGuestContents } from './guestContents'

export const BROWSER_PENDING_CONVERGE_MS = 1000
export const BROWSER_DESTROY_CONFIRM_MS = 4000
export const BROWSER_ATTACH_TIMEOUT_MS = 15000

const CONTROL_UNAVAILABLE = browserNotApplied('unsupported', '页面观察与操控尚未装配')

export interface BrowserSessionHostDeps {
  readonly resolveWorkspaceKey: (sessionId: string) => string | null
  readonly lookupGuest: (webContentsId: number) => BrowserGuestContents | undefined
  readonly delay?: (ms: number) => Promise<void>
  readonly onSnapshot?: (snapshot: BrowserSurfaceSnapshot) => void
  readonly onGuestMount?: (snapshot: BrowserGuestMountSnapshot) => void
  readonly control?: BrowserPageControl
  readonly identity?: BrowserIdentityLedger
  readonly allocatePartition?: (browserId: string) =>
    | { readonly partition: string }
    | { readonly error: 'resource_limit' }
  readonly releasePartition?: (browserId: string) => Promise<void>
  readonly previewGrants?: PreviewGrantStore
  readonly readDisplayScale?: () => number | null
  readonly installPartitionPolicy?: (partition: string) => void
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
  handlePopup(url: string, webContentsId?: number): void
  grantsForGuest(webContentsId: number | undefined): readonly string[]
  grantsForPartition(partition: string): readonly string[]
  noteGuestHandoff(
    webContentsId: number | undefined,
    notice: Pick<BrowserGuestNotice, 'kind' | 'sourceUrl' | 'targetUrl' | 'message'>
  ): void
  inspectBinding(browserId: string): BrowserBindingInspection | null
  livePageCount(): number
  cancelRun(runId: string): void
  releaseAgent(runId: string): void
  revokeSession(sessionId: string): void
}

interface SerialJob {
  readonly runId: string | null
  readonly abort: AbortController
  started: boolean
  abortReason: ReturnType<typeof browserNotApplied> | null
  run: () => Promise<void>
  settleNotApplied: (result: ReturnType<typeof browserNotApplied>) => void
}

interface PageRecord {
  sessionId: string
  url: string
  title: string
  loading: boolean
  lifecycle: BrowserLifecycleStatus
  control: BrowserControlProjection
  faviconUrl: string | null
  loadError: BrowserPageLoadError | null
  partition: string
  visible: boolean
  guest: BrowserGuestContents | null
  attachWaiters: Array<(result: BrowserAttachResult) => void>
  guestListeners: Array<{
    event: Parameters<BrowserGuestContents['on']>[0]
    listener: (...args: unknown[]) => void
  }>
  jobs: SerialJob[]
  serialActive: boolean
  halted: boolean
  layoutViewport: { width: number; height: number } | null
  notice: BrowserGuestNotice | null
}

function defaultDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function uniquePartition(browserId: string): string {
  return `nova-browser-${browserId}`
}

export function createBrowserSessionHost(deps: BrowserSessionHostDeps): BrowserSessionHost {
  const ledger = deps.identity ?? createBrowserIdentityLedger()
  const delay = deps.delay ?? defaultDelay
  const previewGrants = deps.previewGrants ?? createPreviewGrantStore({ findRunning: () => null })
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
        sessionId: record.sessionId,
        src: record.url,
        partition: record.partition,
        visible: record.visible,
        layoutWidth: record.layoutViewport?.width ?? null,
        layoutHeight: record.layoutViewport?.height ?? null
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
    return projectBrowserPage({
      browserId: identity.browserId,
      generation: identity.generation,
      documentEpoch: identity.documentEpoch,
      sessionId: identity.sessionId,
      url: record.url,
      title: record.title,
      loading: record.loading,
      lifecycle: record.lifecycle,
      control: record.control,
      faviconUrl: record.faviconUrl,
      loadError: record.loadError,
      notice: record.notice
    })
  }

  function lookupPage(
    browserId: string,
    sessionId: string
  ): { record: PageRecord; page: BrowserPageProjection } | ReturnType<typeof browserNotApplied> {
    const identity = ledger.inspect(browserId, sessionId)
    if (!identity.ok) return browserNotApplied(identity.code, '页面不属于当前会话或已关闭')
    const record = pages.get(browserId)
    if (!record) return browserNotApplied('page_closed', '页面记录已不存在')
    if (record.lifecycle === 'closing') {
      return browserNotApplied('page_closed', '页面正在关闭')
    }
    if (record.lifecycle === 'failed') {
      return browserNotApplied('unavailable', '页面未能挂载')
    }
    if (record.lifecycle === 'crashed' || record.halted) {
      return browserNotApplied('page_crashed', '页面已崩溃')
    }
    return { record, page: project(identity.value, record) }
  }

  function bindCommandAbort(job: SerialJob, commandSignal?: AbortSignal): void {
    if (!commandSignal) return
    if (commandSignal.aborted) {
      job.abortReason = browserNotApplied('cancelled', '命令已取消')
      job.abort.abort()
      return
    }
    commandSignal.addEventListener(
      'abort',
      () => {
        job.abortReason = browserNotApplied('cancelled', '命令已取消')
        job.abort.abort()
      },
      { once: true }
    )
  }

  function enqueueSerial<T>(
    record: PageRecord,
    context: BrowserCommandContext | undefined,
    task: (signal: AbortSignal) => Promise<T>
  ): Promise<T | ReturnType<typeof browserNotApplied>> {
    const waiting = record.jobs.filter((job) => !job.started).length
    if (context?.authority && waiting >= BROWSER_PENDING_MAX) {
      return Promise.resolve(browserNotApplied('busy', '该页面待执行命令已满'))
    }
    return new Promise((resolve) => {
      const abort = new AbortController()
      let settled = false
      const finish = (value: T | ReturnType<typeof browserNotApplied>): void => {
        if (settled) return
        settled = true
        resolve(value)
      }
      const job: SerialJob = {
        runId: context?.authority?.runId ?? null,
        abort,
        started: false,
        abortReason: null,
        settleNotApplied(result) {
          finish(result)
        },
        run: async () => {
          job.started = true
          if (job.abort.signal.aborted) {
            finish(job.abortReason ?? browserNotApplied('taken_over', '页面控制已撤销'))
            return
          }
          try {
            finish(await task(job.abort.signal))
          } catch (error) {
            finish(
              browserNotApplied(
                'unavailable',
                error instanceof Error ? error.message : '命令失败'
              )
            )
          }
        }
      }
      bindCommandAbort(job, context?.abortSignal)
      record.jobs.push(job)
      void pumpSerial(record)
    })
  }

  async function pumpSerial(record: PageRecord): Promise<void> {
    if (record.serialActive) return
    const job = record.jobs[0]
    if (!job) return
    record.serialActive = true
    try {
      await job.run()
    } finally {
      const idx = record.jobs.indexOf(job)
      if (idx >= 0) record.jobs.splice(idx, 1)
      record.serialActive = false
    }
    await pumpSerial(record)
  }

  function rejectPending(
    record: PageRecord,
    result: ReturnType<typeof browserNotApplied>,
    runId?: string
  ): void {
    const keep: SerialJob[] = []
    for (const job of record.jobs) {
      const match = runId === undefined || job.runId === runId
      if (!match) {
        keep.push(job)
        continue
      }
      if (job.started) {
        job.abortReason = result
        job.abort.abort()
        keep.push(job)
      } else {
        job.settleNotApplied(result)
      }
    }
    record.jobs = keep
  }

  function adoptAgentLease(record: PageRecord, context: BrowserCommandContext): void {
    const runId = context.authority?.runId?.trim()
    if (!runId) return
    const current = record.control
    if (current.holder === 'agent' && current.runId === runId) return
    record.control = { holder: 'agent', runId }
    emit()
  }

  function revokeToUser(
    browserId: string,
    record: PageRecord
  ): ReturnType<BrowserIdentityLedger['bumpGeneration']> {
    const bumped = ledger.bumpGeneration(browserId)
    if (!bumped.ok) return bumped
    record.control = { holder: 'user' }
    rejectPending(record, browserNotApplied('taken_over', '用户已接管此页面'))
    emit()
    return bumped
  }

  function cancelRun(runId: string): void {
    const cancelled = browserNotApplied('cancelled', '任务已取消')
    for (const record of pages.values()) {
      rejectPending(record, cancelled, runId)
    }
  }

  function releaseAgent(runId: string): void {
    let changed = false
    for (const record of pages.values()) {
      if (record.control.holder === 'agent' && record.control.runId === runId) {
        record.control = { holder: 'none' }
        changed = true
      }
    }
    if (changed) emit()
  }

  function revokeSession(sessionId: string): void {
    let changed = false
    for (const [browserId, record] of pages) {
      if (record.sessionId !== sessionId) continue
      if (record.lifecycle === 'closing') continue
      const bumped = ledger.bumpGeneration(browserId)
      if (!bumped.ok) continue
      record.control = { holder: 'none' }
      rejectPending(record, browserNotApplied('taken_over', '已离开该会话'))
      changed = true
    }
    if (changed) emit()
  }

  function unbindGuest(record: PageRecord): void {
    const guest = record.guest
    if (guest) deps.control?.release(guest)
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
      handlePopup(details.url, guest.id)
      return { action: 'deny' }
    })
    listen(record, guest, 'will-navigate', (...args: unknown[]) => {
      const event = args[0] as { preventDefault?: () => void }
      const url = typeof args[1] === 'string' ? args[1] : ''
      if (parseBrowserHttpUrl(url) === null) event.preventDefault?.()
    })
    listen(record, guest, 'did-start-loading', () => {
      record.loading = true
      record.loadError = null
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
      record.faviconUrl = null
      record.notice = null
      ledger.bumpDocumentEpoch(browserId)
      emit()
    })
    listen(record, guest, 'did-navigate-in-page', () => {
      try {
        record.url = guest.getURL() || record.url
      } catch {
        // ignore
      }
      ledger.bumpDocumentEpoch(browserId)
      record.notice = null
      emit()
    })
    listen(record, guest, 'page-title-updated', (...args: unknown[]) => {
      if (typeof args[0] === 'string') record.title = args[0]
      else if (typeof args[1] === 'string') record.title = args[1]
      emit()
    })
    listen(record, guest, 'page-favicon-updated', (...args: unknown[]) => {
      record.faviconUrl = projectFaviconUrl(readGuestFaviconArgs(args))
      emit()
    })
    listen(record, guest, 'did-fail-load', (...args: unknown[]) => {
      const failure = projectGuestLoadError(readGuestLoadFailureArgs(args))
      if (!failure) return
      record.loadError = failure
      record.loading = false
      if (failure.url.length > 0) record.url = failure.url
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
    rejectPending(record, browserNotApplied('page_crashed', '页面已崩溃'))
    emit()
    await convergePending(record)
    if (!detachDebugger(record.guest)) {
      emit()
      return
    }
    ledger.bumpGeneration(browserId)
    emit()
  }

  function handlePopup(url: string, webContentsId?: number): void {
    if (webContentsId === undefined) return
    const browserId = findOwnerByGuestId(webContentsId)
    if (!browserId) return
    const record = pages.get(browserId)
    if (!record || record.lifecycle === 'closing') return
    const identity = ledger.inspect(browserId, record.sessionId)
    if (!identity.ok) return
    const decision = routeGuestPopup(url)
    record.notice = {
      kind: 'popup',
      sourceUrl: record.url,
      targetUrl: decision.targetUrl,
      message: decision.targetUrl
        ? `已拒绝新窗口。来源 ${record.url}，目标 ${decision.targetUrl}。依赖原窗口通信的登录弹窗暂不支持。`
        : `已拒绝新窗口。来源 ${record.url}，目标不是 http 或 https。`,
      generation: identity.value.generation,
      documentEpoch: identity.value.documentEpoch
    }
    emit()
  }

  function grantsForGuest(webContentsId: number | undefined): readonly string[] {
    if (webContentsId === undefined) return []
    const browserId = findOwnerByGuestId(webContentsId)
    if (!browserId) return []
    return grantsForBrowser(browserId)
  }

  function grantsForPartition(partition: string): readonly string[] {
    for (const [browserId, record] of pages) {
      if (record.partition === partition && record.lifecycle !== 'closing') {
        return grantsForBrowser(browserId)
      }
    }
    return []
  }

  function grantsForBrowser(browserId: string): readonly string[] {
    const record = pages.get(browserId)
    if (!record) return []
    const workspaceKey = deps.resolveWorkspaceKey(record.sessionId)
    if (workspaceKey === null) return []
    return previewGrants.grantedOrigins(workspaceKey, record.sessionId)
  }

  function noteGuestHandoff(
    webContentsId: number | undefined,
    notice: Pick<BrowserGuestNotice, 'kind' | 'sourceUrl' | 'targetUrl' | 'message'>
  ): void {
    if (webContentsId === undefined) return
    const browserId = findOwnerByGuestId(webContentsId)
    if (!browserId) return
    const record = pages.get(browserId)
    if (!record || record.lifecycle === 'closing') return
    const identity = ledger.inspect(browserId, record.sessionId)
    if (!identity.ok) return
    record.notice = {
      ...notice,
      generation: identity.value.generation,
      documentEpoch: identity.value.documentEpoch
    }
    emit()
  }

  function occupiesSlot(record: PageRecord): boolean {
    return record.lifecycle !== 'closing'
  }

  function livePageCount(): number {
    let live = 0
    for (const record of pages.values()) {
      if (occupiesSlot(record)) live += 1
    }
    return live
  }

  function rejectStaleAttach(record: PageRecord): ReturnType<typeof browserNotApplied> | null {
    if (record.lifecycle === 'closing') {
      return browserNotApplied('page_closed', '页面正在关闭')
    }
    if (record.lifecycle === 'failed' || record.halted) {
      return browserNotApplied('unavailable', '页面挂载已失败，拒绝迟到绑定')
    }
    return null
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
    const confirmed = previewGrants.confirm({
      workspaceKey,
      sessionId: context.sessionId,
      url
    })
    if (!confirmed.ok) return browserNotApplied(confirmed.code, confirmed.detail)
    const issued = ledger.issuePage({ sessionId: context.sessionId, workspaceKey })
    if (!issued.ok) {
      if (issued.code === 'resource_limit') {
        return browserNotApplied(issued.code, BROWSER_PAGE_CAP_MESSAGE)
      }
      return browserNotApplied(issued.code, '无法打开新的浏览器页面')
    }
    const allocated = deps.allocatePartition
      ? deps.allocatePartition(issued.value.browserId)
      : { partition: uniquePartition(issued.value.browserId) }
    if ('error' in allocated) {
      ledger.retire(issued.value.browserId)
      return browserNotApplied(allocated.error, '没有可复用的隔离资料槽')
    }
    deps.installPartitionPolicy?.(allocated.partition)
    const record: PageRecord = {
      sessionId: context.sessionId,
      url,
      title: '',
      loading: true,
      lifecycle: 'opening',
      control: context.authority?.runId
        ? { holder: 'agent', runId: context.authority.runId }
        : { holder: 'user' },
      faviconUrl: null,
      loadError: null,
      partition: allocated.partition,
      visible: true,
      guest: null,
      attachWaiters: [],
      guestListeners: [],
      jobs: [],
      serialActive: false,
      halted: false,
      layoutViewport: null,
      notice: null
    }
    pages.set(issued.value.browserId, record)
    emit()
    const attached = new Promise<BrowserAttachResult>((resolve) => {
      record.attachWaiters.push(resolve)
    })
    const browserId = issued.value.browserId
    return Promise.race([
      attached,
      delay(BROWSER_ATTACH_TIMEOUT_MS).then((): BrowserAttachResult => {
        const current = pages.get(browserId)
        if (current !== record) {
          return browserNotApplied('page_closed', '页面记录已不存在')
        }
        if (record.lifecycle === 'opening' && record.guest === null) {
          record.lifecycle = 'failed'
          record.halted = true
          record.loading = false
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
    const identity = ledger.inspect(params.browserId, params.sessionId)
    if (!identity.ok) return browserNotApplied(identity.code, '页面不属于当前会话或已关闭')
    const record = pages.get(params.browserId)
    if (!record) return browserNotApplied('page_closed', '页面记录已不存在')
    const stale = rejectStaleAttach(record)
    if (stale) return stale
    return enqueueSerial(record, undefined, async () => {
      const rejected = rejectStaleAttach(record)
      if (rejected) return rejected
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
      if (record.guest && record.guest.id === guest.id) {
        return finishAttach(params.browserId, params.sessionId, record)
      }
      if (record.guest && !safeDestroyed(record.guest)) {
        return browserNotApplied('unavailable', '旧页面进程仍在，拒绝抢绑')
      }
      bindGuest(params.browserId, record, guest, params.sessionId)
      record.loading = safeLoading(guest)
      try {
        record.url = guest.getURL() || record.url
        record.title = guest.getTitle() || record.title
      } catch {
        // ignore
      }
      return finishAttach(params.browserId, params.sessionId, record)
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
    const rejected = rejectStaleAttach(record)
    if (rejected) {
      unbindGuest(record)
      return rejected
    }
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

  function safeGuestUrl(guest: BrowserGuestContents): string {
    try {
      return guest.getURL()
    } catch {
      return ''
    }
  }

  async function waitForCommittedDocument(
    guest: BrowserGuestContents,
    stillCurrent: BrowserControlFence['stillCurrent'],
    signal: AbortSignal
  ): Promise<ReturnType<typeof browserNotApplied> | null> {
    const deadline = Date.now() + 8_000
    while (Date.now() <= deadline) {
      const current = stillCurrent()
      if (!current.ok) {
        return browserNotApplied(
          current.code,
          current.code === 'cancelled' ? '命令已取消' : '页面控制已撤销'
        )
      }
      if (safeDestroyed(guest)) return browserNotApplied('page_closed', '页面已关闭')
      const url = safeGuestUrl(guest)
      if (!safeLoading(guest) && url.length > 0 && url !== 'about:blank') return null
      await new Promise<void>((resolve) => {
        if (signal.aborted) {
          resolve()
          return
        }
        let settled = false
        const finish = (): void => {
          if (settled) return
          settled = true
          signal.removeEventListener('abort', finish)
          resolve()
        }
        signal.addEventListener('abort', finish)
        void delay(50).then(finish)
      })
    }
    return browserNotApplied('timeout', '页面还没有完成当前加载')
  }

  async function navigate(
    command: BrowserNavigateCommand,
    context: BrowserCommandContext
  ): Promise<BrowserNavigateResult> {
    const found = lookupPage(command.browserId, context.sessionId)
    if ('status' in found) return found
    if (command.action.kind === 'dismiss-notice') {
      found.record.notice = null
      emit()
      const identity = ledger.inspect(command.browserId, context.sessionId)
      if (!identity.ok) return browserNotApplied(identity.code, '页面不属于当前会话或已关闭')
      return { status: 'applied', page: project(identity.value, found.record) }
    }
    let action = command.action
    let popupEpoch: number | null = null
    if (action.kind === 'accept-popup') {
      const identity = ledger.inspect(command.browserId, context.sessionId)
      const notice = found.record.notice
      if (
        !identity.ok
        || !notice
        || notice.kind !== 'popup'
        || notice.targetUrl === null
        || notice.generation !== identity.value.generation
        || notice.documentEpoch !== identity.value.documentEpoch
      ) {
        found.record.notice = null
        emit()
        return browserNotApplied('stale_observation', '弹窗来源已变化，没有打开')
      }
      popupEpoch = identity.value.documentEpoch
      action = { kind: 'url', url: notice.targetUrl }
      found.record.notice = null
    }
    if (!context.authority) {
      const revoked = revokeToUser(command.browserId, found.record)
      if (!revoked.ok) return browserNotApplied(revoked.code, '无法接管该页面')
    } else {
      adoptAgentLease(found.record, context)
    }
    return enqueueSerial(found.record, context, async (signal) => {
      const guest = found.record.guest
      if (!guest || safeDestroyed(guest)) {
        return browserNotApplied('unavailable', '页面尚未挂载')
      }
      try {
        if (popupEpoch !== null) {
          const current = ledger.inspect(command.browserId, context.sessionId)
          if (!current.ok || current.value.documentEpoch !== popupEpoch) {
            return browserNotApplied('stale_observation', '弹窗来源已变化，没有打开')
          }
        }
        if (action.kind === 'url') {
          const workspaceKey = deps.resolveWorkspaceKey(context.sessionId)
          if (workspaceKey === null) {
            return browserNotApplied('not_owner', '当前会话没有可绑定的工作区')
          }
          const confirmed = previewGrants.confirm({
            workspaceKey,
            sessionId: context.sessionId,
            url: action.url
          })
          if (!confirmed.ok) return browserNotApplied(confirmed.code, confirmed.detail)
          found.record.loading = true
          if (!deps.control) found.record.url = action.url
          emit()
          if (deps.control) {
            const identity = ledger.inspect(command.browserId, context.sessionId)
            if (!identity.ok) return browserNotApplied(identity.code, '页面不属于当前会话或已关闭')
            const loaded = await deps.control.load(
              guest,
              navigationFence(command.browserId, context.sessionId, identity.value.generation, signal),
              action.url
            )
            if (loaded.status !== 'applied') return loaded
            found.record.url = action.url
            emit()
          } else {
            await guest.loadURL(action.url)
          }
        } else if (action.kind === 'back') guest.goBack()
        else if (action.kind === 'forward') guest.goForward()
        else if (action.kind === 'reload') guest.reload()
        else if (action.kind === 'stop') guest.stop()
        else return browserNotApplied('invalid_request', '未知的导航动作')
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
    rejectPending(record, browserNotApplied('page_closed', '页面正在关闭'))
    return enqueueSerial(record, context, async () => {
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
      if (deps.releasePartition) {
        await deps.releasePartition(command.browserId)
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
    return enqueueSerial(found.record, undefined, async () => {
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
    const bumped = revokeToUser(command.browserId, found.record)
    if (!bumped.ok) return browserNotApplied(bumped.code, '无法接管该页面')
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

  function navigationFence(
    browserId: string,
    sessionId: string,
    generation: number,
    signal?: AbortSignal
  ): BrowserControlFence {
    return {
      generation,
      documentEpoch: 0,
      observationId: null,
      signal,
      stillCurrent() {
        const record = pages.get(browserId)
        if (!record || record.lifecycle === 'closing') return { ok: false, code: 'page_closed' }
        if (record.lifecycle === 'crashed' || record.halted) return { ok: false, code: 'page_crashed' }
        const now = ledger.inspect(browserId, sessionId)
        if (!now.ok) return { ok: false, code: now.code === 'page_closed' ? 'page_closed' : 'not_owner' }
        if (now.value.generation !== generation) return { ok: false, code: 'taken_over' }
        if (signal?.aborted) return { ok: false, code: 'cancelled' }
        return { ok: true }
      }
    }
  }

  function actionFence(
    browserId: string,
    sessionId: string,
    start: { generation: number; documentEpoch: number },
    observationId: string | null,
    signal?: AbortSignal
  ): BrowserControlFence {
    return {
      generation: start.generation,
      documentEpoch: start.documentEpoch,
      observationId,
      signal,
      stillCurrent() {
        const record = pages.get(browserId)
        if (!record || record.lifecycle === 'closing') return { ok: false, code: 'page_closed' }
        if (record.lifecycle === 'crashed' || record.halted) return { ok: false, code: 'page_crashed' }
        if (observationId) {
          const matched = ledger.matchObservation(
            {
              browserId,
              generation: start.generation,
              documentEpoch: start.documentEpoch,
              observationId
            },
            sessionId
          )
          if (!matched.ok) return { ok: false, code: matched.code }
          if (signal?.aborted) return { ok: false, code: 'cancelled' }
          return { ok: true }
        }
        const now = ledger.inspect(browserId, sessionId)
        if (!now.ok) return { ok: false, code: now.code === 'page_closed' ? 'page_closed' : 'not_owner' }
        if (now.value.generation !== start.generation) return { ok: false, code: 'taken_over' }
        if (now.value.documentEpoch !== start.documentEpoch) return { ok: false, code: 'stale_observation' }
        if (signal?.aborted) return { ok: false, code: 'cancelled' }
        return { ok: true }
      }
    }
  }

  async function observe(
    command: BrowserObserveCommand,
    context: BrowserCommandContext
  ): Promise<BrowserObserveResult> {
    if (!deps.control) return CONTROL_UNAVAILABLE
    const found = lookupPage(command.browserId, context.sessionId)
    if ('status' in found) return found
    return enqueueSerial(found.record, context, async (signal) => {
      adoptAgentLease(found.record, context)
      const guest = found.record.guest
      if (!guest || safeDestroyed(guest)) return browserNotApplied('unavailable', '页面尚未挂载')
      const start = ledger.inspect(command.browserId, context.sessionId)
      if (!start.ok) return browserNotApplied(start.code, '页面不属于当前会话或已关闭')
      const waitFence = navigationFence(
        command.browserId,
        context.sessionId,
        start.value.generation,
        signal
      )
      const settled = await waitForCommittedDocument(guest, () => waitFence.stillCurrent(), signal)
      if (settled) return settled
      const identity = ledger.inspect(command.browserId, context.sessionId)
      if (!identity.ok) return browserNotApplied(identity.code, '页面不属于当前会话或已关闭')
      const fence = actionFence(
        command.browserId,
        context.sessionId,
        identity.value,
        null,
        signal
      )
      const read = await deps.control!.observe(guest, fence)
      if (read.status !== 'applied') return read
      const current = fence.stillCurrent()
      if (!current.ok) return browserNotApplied(current.code, '观察结果已过期')
      const issued = ledger.issueObservation(command.browserId)
      if (!issued.ok) return browserNotApplied(issued.code, '无法签发观察')
      deps.control!.bindRefs(issued.value.observationId, read.read.refs)
      const displayScale = deps.readDisplayScale?.() ?? read.read.snapshot.viewport.displayScale
      return {
        status: 'applied',
        observation: issued.value,
        snapshot: {
          ...read.read.snapshot,
          viewport: { ...read.read.snapshot.viewport, displayScale }
        }
      }
    })
  }

  async function act(command: BrowserActCommand, context: BrowserCommandContext): Promise<ActionOutcome> {
    if (!deps.control) return CONTROL_UNAVAILABLE
    const matched = ledger.matchObservation(command.observation, context.sessionId)
    if (!matched.ok) return browserNotApplied(matched.code, '观察已不能用于操作')
    const found = lookupPage(command.observation.browserId, context.sessionId)
    if ('status' in found) return found
    return enqueueSerial(found.record, context, async (signal) => {
      adoptAgentLease(found.record, context)
      const again = ledger.matchObservation(command.observation, context.sessionId)
      if (!again.ok) return browserNotApplied(again.code, '观察已不能用于操作')
      const guest = found.record.guest
      if (!guest || safeDestroyed(guest)) return browserNotApplied('unavailable', '页面尚未挂载')
      const fence = actionFence(
        command.observation.browserId,
        context.sessionId,
        command.observation,
        command.observation.observationId,
        signal
      )
      const previousLayout = found.record.layoutViewport
      if (command.action.kind === 'viewport') {
        found.record.layoutViewport = { width: command.action.width, height: command.action.height }
        emit()
      }
      const result = await deps.control!.act(guest, fence, command.action)
      if (command.action.kind === 'viewport' && result.status !== 'applied') {
        const lease = fence.stillCurrent()
        if (lease.ok) {
          found.record.layoutViewport = previousLayout
          emit()
        }
      }
      if (result.status !== 'applied') return result
      if (signal.aborted) {
        return { status: 'outcome_unknown', detail: '动作已经发出，但命令已取消' }
      }
      const finalMatch = ledger.matchObservation(command.observation, context.sessionId)
      if (!finalMatch.ok) {
        return { status: 'outcome_unknown', detail: '动作已经发出，但不能写回当前页面' }
      }
      return { status: 'applied', observation: finalMatch.value, summary: result.summary }
    })
  }

  async function capture(
    command: BrowserCaptureCommand,
    context: BrowserCommandContext
  ): Promise<BrowserCaptureResult> {
    if (!deps.control) return CONTROL_UNAVAILABLE
    const matched = ledger.matchObservation(command.observation, context.sessionId)
    if (!matched.ok) return browserNotApplied(matched.code, '观察已不能用于截图')
    const found = lookupPage(command.observation.browserId, context.sessionId)
    if ('status' in found) return found
    return enqueueSerial(found.record, context, async (signal) => {
      adoptAgentLease(found.record, context)
      const again = ledger.matchObservation(command.observation, context.sessionId)
      if (!again.ok) return browserNotApplied(again.code, '观察已不能用于截图')
      const guest = found.record.guest
      if (!guest || safeDestroyed(guest)) return browserNotApplied('unavailable', '页面尚未挂载')
      const fence = actionFence(
        command.observation.browserId,
        context.sessionId,
        command.observation,
        command.observation.observationId,
        signal
      )
      const shot = await deps.control!.capture(guest, fence)
      if (shot.status !== 'applied') return shot
      if (signal.aborted) {
        return { status: 'outcome_unknown', detail: '截图已经发出，但命令已取消' }
      }
      const finalMatch = ledger.matchObservation(command.observation, context.sessionId)
      if (!finalMatch.ok) {
        return { status: 'outcome_unknown', detail: '截图已经发出，但不能写回当前页面' }
      }
      const displayScale = deps.readDisplayScale?.() ?? shot.viewport.displayScale
      return {
        status: 'applied',
        observation: finalMatch.value,
        width: shot.width,
        height: shot.height,
        capturedAt: Date.now(),
        viewport: { ...shot.viewport, displayScale },
        image: { mimeType: 'image/png', base64: shot.base64 }
      }
    })
  }

  function noteRendererReloading(): void {
    for (const record of pages.values()) {
      if (record.lifecycle === 'closing' || record.lifecycle === 'failed') continue
      unbindGuest(record)
      if (record.lifecycle === 'ready' || record.lifecycle === 'hidden') {
        record.lifecycle = 'opening'
      }
      if (record.lifecycle !== 'crashed') {
        failAttachWaiters(record, browserNotApplied('unavailable', '界面已重新加载，等待重新挂载'))
      }
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
    observe,
    act,
    capture,
    close,
    listPages,
    claim,
    release,
    attach,
    hide: (browserId, sessionId) => setVisible(browserId, sessionId, false),
    restore: (browserId, sessionId) => setVisible(browserId, sessionId, true),
    noteRendererReloading,
    handlePopup,
    grantsForGuest,
    grantsForPartition,
    noteGuestHandoff,
    inspectBinding,
    livePageCount,
    cancelRun,
    releaseAgent,
    revokeSession
  }
}
