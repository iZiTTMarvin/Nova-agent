/**
 * 内置浏览器页面记录与 guest 生命周期的唯一 Owner。
 * CDP 与隔离世界交给 BrowserPageControl；这里不实现协议。
 */
import {
  BROWSER_MAX_LIVE_PAGES,
  BROWSER_PAGE_CAP_MESSAGE,
  BROWSER_PENDING_MAX,
  browserNotApplied,
  canonicalizePreviewTarget,
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
  type BrowserUnknownOutcome,
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
  navigationTargetOrigin: string | null
}

/**
 * 等待打开确认（域名地址解析）的命令。此时尚无页面记录，
 * 取消与离开会话的撤销遍历不到它，须在这里登记后于提交前复核。
 */
interface PendingOpen {
  readonly sessionId: string
  readonly runId: string | null
  revoked: ReturnType<typeof browserNotApplied> | null
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
  const pendingOpens = new Set<PendingOpen>()
  let sequence = 0

  function revokePendingOpens(
    result: ReturnType<typeof browserNotApplied>,
    match: { readonly runId?: string; readonly sessionId?: string }
  ): void {
    for (const pending of pendingOpens) {
      if (pending.revoked) continue
      if (match.runId !== undefined && pending.runId !== match.runId) continue
      if (match.sessionId !== undefined && pending.sessionId !== match.sessionId) continue
      pending.revoked = result
    }
  }

  function emit(): void {
    sequence += 1
    deps.onSnapshot?.(snapshot())
    deps.onGuestMount?.(guestSnapshot())
  }

  function snapshot(): BrowserSurfaceSnapshot {
    return surfaceSnapshot(() => true)
  }

  /**
   * 工具与快照查询只拿得到所属会话的页面投影；
   * 全局 UI 广播与页面名额仍以全部页面为准。
   */
  function snapshotForSession(sessionId: string): BrowserSurfaceSnapshot {
    return surfaceSnapshot((record) => record.sessionId === sessionId)
  }

  function surfaceSnapshot(include: (record: PageRecord) => boolean): BrowserSurfaceSnapshot {
    const list: BrowserPageProjection[] = []
    let activeBrowserId: string | null = null
    for (const [browserId, record] of pages) {
      if (!include(record)) continue
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

  /**
   * 控制权由 Host 统一决定：用户明确接管（holder=user）后，AI 命令不得隐式夺回，
   * 只能等用户交还。返回是否取得或已持有控制资格。
   */
  function adoptAgentLease(record: PageRecord, context: BrowserCommandContext): boolean {
    const runId = context.authority?.runId?.trim()
    if (!runId) return record.control.holder !== 'user'
    const current = record.control
    if (current.holder === 'agent' && current.runId === runId) return true
    if (current.holder === 'user') return false
    record.control = { holder: 'agent', runId }
    emit()
    return true
  }

  /** AI 写命令（带 authority）在入队与实际执行前的控制资格检查；用户接管期间一律拒绝。 */
  function agentWriteDenied(record: PageRecord): ReturnType<typeof browserNotApplied> | null {
    if (record.control.holder !== 'user') return null
    return browserNotApplied('taken_over', '用户已接管此页面，需要用户交还后才能继续操作')
  }

  function revokeToUser(
    browserId: string,
    record: PageRecord
  ): ReturnType<BrowserIdentityLedger['bumpGeneration']> {
    const bumped = ledger.bumpGeneration(browserId)
    if (!bumped.ok) return bumped
    record.control = { holder: 'user' }
    record.navigationTargetOrigin = null
    rejectPending(record, browserNotApplied('taken_over', '用户已接管此页面'))
    emit()
    return bumped
  }

  function cancelRun(runId: string): void {
    const cancelled = browserNotApplied('cancelled', '任务已取消')
    for (const record of pages.values()) {
      rejectPending(record, cancelled, runId)
      if (record.control.holder === 'agent' && record.control.runId === runId) {
        record.navigationTargetOrigin = null
      }
    }
    revokePendingOpens(cancelled, { runId })
  }

  function releaseAgent(runId: string): void {
    let changed = false
    for (const record of pages.values()) {
      if (record.control.holder === 'agent' && record.control.runId === runId) {
        record.control = { holder: 'none' }
        record.navigationTargetOrigin = null
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
      record.navigationTargetOrigin = null
      rejectPending(record, browserNotApplied('taken_over', '已离开该会话'))
      changed = true
    }
    revokePendingOpens(browserNotApplied('taken_over', '已离开该会话'), { sessionId })
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
      record.navigationTargetOrigin = null
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
      record.navigationTargetOrigin = null
      if (failure.url.length > 0) record.url = failure.url
      emit()
    })
    listen(record, guest, 'destroyed', () => {
      if (record.lifecycle === 'closing') return
      unbindGuest(record)
      record.navigationTargetOrigin = null
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
    record.navigationTargetOrigin = null
    previewGrants.release(browserId)
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
    if (record.halted || record.lifecycle === 'closing' || record.lifecycle === 'crashed') return []
    const workspaceKey = deps.resolveWorkspaceKey(record.sessionId)
    if (workspaceKey === null) return []
    const guestUrl = record.guest ? safeGuestUrl(record.guest) : ''
    const currentUrl = guestUrl && guestUrl !== 'about:blank'
      ? guestUrl
      : record.lifecycle === 'opening' ? record.url : ''
    const origin = record.navigationTargetOrigin ?? canonicalizePreviewTarget(currentUrl)?.origin
    if (!origin) return []
    return previewGrants.grantedOrigins(browserId, workspaceKey, record.sessionId)
      .filter((granted) => granted === origin)
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
    // 域名地址确认可能等待解析：登记进撤销生命周期，提交前复核运行、会话与工作区资格
    const pending: PendingOpen = {
      sessionId: context.sessionId,
      runId: context.authority?.runId?.trim() ?? null,
      revoked: null
    }
    pendingOpens.add(pending)
    const confirmed = await previewGrants.confirm({
      workspaceKey,
      sessionId: context.sessionId,
      url
    })
    pendingOpens.delete(pending)
    if (context.abortSignal?.aborted) return browserNotApplied('cancelled', '命令已取消')
    if (pending.revoked) return pending.revoked
    if (deps.resolveWorkspaceKey(context.sessionId) === null) {
      return browserNotApplied('not_owner', '当前会话没有可绑定的工作区')
    }
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
      // 人工打开只表示尚无人取得控制；明确接管只来自 claim 或用户主动导航
      control: context.authority?.runId
        ? { holder: 'agent', runId: context.authority.runId }
        : { holder: 'none' },
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
      notice: null,
      navigationTargetOrigin: confirmed.restricted ? confirmed.grant.origin : null
    }
    pages.set(issued.value.browserId, record)
    if (confirmed.restricted) previewGrants.activate(issued.value.browserId, confirmed.grant)
    emit()
    const attached = new Promise<BrowserAttachResult>((resolve) => {
      record.attachWaiters.push(resolve)
    })
    const browserId = issued.value.browserId
    const mounted = await Promise.race([
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
          previewGrants.release(browserId)
          const timeout = browserNotApplied('timeout', '页面未能在时限内挂载')
          failAttachWaiters(record, timeout)
          emit()
          return timeout
        }
        return browserNotApplied('timeout', '页面未能在时限内挂载')
      })
    ])
    if (mounted.status !== 'applied' || !context.authority) return mounted
    return settleAgentOpen(browserId, record, context, mounted)
  }

  /**
   * 代理打开的页面要等首个文档提交后再回报：挂载时首屏往往还没提交，紧接着的跳转会把它从历史里顶掉
   * （之后后退无效），回报的地址和标题也不真实。等待失败不改变「页面已打开」的事实，只体现在加载状态里。
   * 人工打开不等待，面板靠快照推送渲染。
   */
  async function settleAgentOpen(
    browserId: string,
    record: PageRecord,
    context: BrowserCommandContext,
    mounted: Extract<BrowserAttachResult, { status: 'applied' }>
  ): Promise<BrowserOpenResult> {
    const guest = record.guest
    const identity = ledger.inspect(browserId, context.sessionId)
    if (!guest || !identity.ok) return mounted
    const signal = context.abortSignal ?? new AbortController().signal
    const fence = navigationFence(browserId, context.sessionId, identity.value.generation, context.abortSignal)
    await waitForCommittedDocument(guest, () => fence.stillCurrent(), signal)
    const latest = ledger.inspect(browserId, context.sessionId)
    if (!latest.ok || pages.get(browserId) !== record) return mounted
    return { status: 'applied', page: project(latest.value, record) }
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
      await pollPause(signal)
    }
    return browserNotApplied('timeout', '页面还没有完成当前加载')
  }

  /**
   * 代理发起的后退、前进、刷新要等新文档提交并加载结束再回报，否则回报的仍是旧地址，
   * 模型会以为没生效而重复操作。did-navigate / did-navigate-in-page 会推进 documentEpoch，以此判断已提交。
   * 动作已经发出，所以等不到结果时只能报「结果未确认」，不能报「没有执行」。
   */
  async function waitForHistoryNavigation(
    browserId: string,
    sessionId: string,
    guest: BrowserGuestContents,
    from: { generation: number; documentEpoch: number },
    signal: AbortSignal
  ): Promise<BrowserUnknownOutcome | null> {
    const fence = navigationFence(browserId, sessionId, from.generation, signal)
    const unknown = (reason: string): BrowserUnknownOutcome => ({
      status: 'outcome_unknown',
      detail: `导航已经发出，但${reason}`
    })
    const deadline = Date.now() + 8_000
    while (Date.now() <= deadline) {
      const current = fence.stillCurrent()
      if (!current.ok) return unknown(current.code === 'cancelled' ? '命令已取消' : '页面控制已变化')
      const identity = ledger.inspect(browserId, sessionId)
      if (identity.ok && identity.value.documentEpoch !== from.documentEpoch) {
        const settled = await waitForCommittedDocument(guest, () => fence.stillCurrent(), signal)
        return settled ? unknown(settled.detail) : null
      }
      await pollPause(signal)
    }
    return unknown('页面没有在时限内完成导航')
  }

  function pollPause(signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
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
      const denied = agentWriteDenied(found.record)
      if (denied) return denied
      adoptAgentLease(found.record, context)
    }
    return enqueueSerial(found.record, context, async (signal) => {
      const denied = context.authority ? agentWriteDenied(found.record) : null
      if (denied) return denied
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
          // 等待域名确认前固定身份；等待后写入授权与导航前复核
          const beforeConfirm = ledger.inspect(command.browserId, context.sessionId)
          if (!beforeConfirm.ok) {
            return browserNotApplied(beforeConfirm.code, '页面不属于当前会话或已关闭')
          }
          const confirmed = await previewGrants.confirm({
            workspaceKey,
            sessionId: context.sessionId,
            url: action.url
          })
          if (!confirmed.ok) return browserNotApplied(confirmed.code, confirmed.detail)
          // 复核顺序：先看身份（区分接管与页面失效），再看命令自身的取消信号
          const afterConfirm = ledger.inspect(command.browserId, context.sessionId)
          if (!afterConfirm.ok) {
            return browserNotApplied(afterConfirm.code, '页面不属于当前会话或已关闭')
          }
          if (afterConfirm.value.generation !== beforeConfirm.value.generation) {
            return browserNotApplied('taken_over', '页面控制已变化，导航没有执行')
          }
          if (signal.aborted) return browserNotApplied('cancelled', '命令已取消')
          if (confirmed.restricted) previewGrants.activate(command.browserId, confirmed.grant)
          found.record.navigationTargetOrigin = canonicalizePreviewTarget(action.url)?.origin ?? null
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
            if (loaded.status !== 'applied') {
              found.record.navigationTargetOrigin = null
              return loaded
            }
            found.record.url = safeGuestUrl(guest) || action.url
            found.record.navigationTargetOrigin = null
            emit()
          } else {
            await guest.loadURL(action.url)
            found.record.navigationTargetOrigin = null
          }
        } else if (action.kind === 'back' || action.kind === 'forward' || action.kind === 'reload') {
          const before = ledger.inspect(command.browserId, context.sessionId)
          if (!before.ok) return browserNotApplied(before.code, '页面不属于当前会话或已关闭')
          if (action.kind === 'reload') {
            found.record.navigationTargetOrigin = canonicalizePreviewTarget(found.record.url)?.origin ?? null
            guest.reload()
          } else {
            const target = guest.historyTarget(action.kind)
            if (target === null) {
              return browserNotApplied(
                'navigation_failed',
                action.kind === 'back' ? '没有可后退的页面' : '没有可前进的页面'
              )
            }
            found.record.navigationTargetOrigin = canonicalizePreviewTarget(target)?.origin ?? null
            if (action.kind === 'back') guest.goBack()
            else guest.goForward()
          }
          // 人工导航不等待：面板靠快照推送渲染，后续人工操作会直接接管
          if (context.authority) {
            const unsettled = await waitForHistoryNavigation(
              command.browserId,
              context.sessionId,
              guest,
              before.value,
              signal
            )
            if (unsettled) return unsettled
          }
        } else if (action.kind === 'stop') {
          found.record.navigationTargetOrigin = null
          guest.stop()
        }
        else return browserNotApplied('invalid_request', '未知的导航动作')
      } catch (error) {
        found.record.navigationTargetOrigin = null
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
    if (context.authority) {
      const denied = agentWriteDenied(record)
      if (denied) return denied
    }
    rejectPending(record, browserNotApplied('page_closed', '页面正在关闭'))
    return enqueueSerial(record, context, async () => {
      record.lifecycle = 'closing'
      record.visible = false
      record.halted = true
      record.navigationTargetOrigin = null
      previewGrants.release(command.browserId)
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
    // 交还同样提升世代：接管前的旧观察不得在交还后复活
    const bumped = ledger.bumpGeneration(command.browserId)
    if (!bumped.ok) return browserNotApplied(bumped.code, '无法交还该页面')
    found.record.control = { holder: 'none' }
    emit()
    return { status: 'applied', page: project(bumped.value, found.record) }
  }

  function listPages(
    command: BrowserListCommand,
    context: BrowserCommandContext
  ): Promise<BrowserListResult> {
    if (command.sessionId !== context.sessionId) {
      return Promise.resolve(browserNotApplied('not_owner', '不能读取其它会话的页面'))
    }
    emit()
    return Promise.resolve({ status: 'applied', snapshot: snapshotForSession(context.sessionId) })
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
      // 观察只读：用户接管期间仍可看，但不因此取得控制权
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
    const deniedBefore = context.authority ? agentWriteDenied(found.record) : null
    if (deniedBefore) return deniedBefore
    return enqueueSerial(found.record, context, async (signal) => {
      const denied = context.authority ? agentWriteDenied(found.record) : null
      if (denied) return denied
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
        // 尺寸只在验收后留下。租约中途失效时，这次提前写上的布局也要收回。
        found.record.layoutViewport = previousLayout
        emit()
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
      // 截图只读：用户接管期间仍可拍，但不因此取得控制权
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
