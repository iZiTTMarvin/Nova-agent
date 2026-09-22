import { describe, expect, it } from 'vitest'
import { ProcessRegistry } from '../../../../src/runtime/process'
import type { BrowserPageControl } from '../../../../src/main/browser/controlPort'
import {
  createPreviewGrantStore,
  type PreviewGrantStore
} from '../../../../src/main/browser/previewGrants'
import { findOwnedPreviewRef } from '../../../../src/main/browser/previewProcess'
import {
  createBrowserSessionHost,
  type BrowserSessionHost
} from '../../../../src/main/browser/sessionHost'
import type { BrowserGuestContents, BrowserGuestEvent } from '../../../../src/main/browser/guestContents'
import type { BrowserGuestMountSnapshot, BrowserSurfaceSnapshot } from '../../../../src/shared/browser'
import type { BrowserCommandContext } from '../../../../src/runtime/browser'

class FakeGuest implements BrowserGuestContents {
  readonly id: number
  type: string
  destroyed = false
  crashed = false
  url: string
  title = ''
  loading = false
  debuggerAttached: boolean
  detachImpl: () => void
  private readonly listeners = new Map<BrowserGuestEvent, Set<(...args: unknown[]) => void>>()

  constructor(init: {
    id: number
    type?: string
    url?: string
    debuggerAttached?: boolean
    detachImpl?: () => void
  }) {
    this.id = init.id
    this.type = init.type ?? 'webview'
    this.url = init.url ?? 'https://example.com'
    this.debuggerAttached = init.debuggerAttached ?? false
    this.detachImpl = init.detachImpl ?? (() => { this.debuggerAttached = false })
  }

  getType(): string {
    return this.type
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  isCrashed(): boolean {
    return this.crashed
  }

  getURL(): string {
    return this.url
  }

  getTitle(): string {
    return this.title
  }

  isLoading(): boolean {
    return this.loading
  }

  async loadURL(url: string): Promise<void> {
    this.url = url
  }

  goBack(): void {}
  goForward(): void {}
  reload(): void {}
  stop(): void {}
  setWindowOpenHandler(): void {}

  debugger = {
    isAttached: (): boolean => this.debuggerAttached,
    attach: (protocol: string): void => {
      void protocol
      this.debuggerAttached = true
    },
    detach: (): void => {
      this.detachImpl()
    },
    sendCommand: async (): Promise<unknown> => {
      throw new Error('sendCommand 未实现')
    },
    on: (): void => {},
    off: (): void => {}
  }

  async capturePage(): Promise<{ toPNG(): Buffer; getSize(): { width: number; height: number } }> {
    throw new Error('capturePage 未实现')
  }

  on(event: BrowserGuestEvent, listener: (...args: unknown[]) => void): void {
    const set = this.listeners.get(event) ?? new Set()
    set.add(listener)
    this.listeners.set(event, set)
  }

  off(event: BrowserGuestEvent, listener: (...args: unknown[]) => void): void {
    this.listeners.get(event)?.delete(listener)
  }

  emit(event: BrowserGuestEvent, ...args: unknown[]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) {
      listener(...args)
    }
  }

  destroy(): void {
    this.destroyed = true
    const listeners = [...(this.listeners.get('destroyed') ?? [])]
    for (const listener of listeners) listener()
  }

  crash(): void {
    this.crashed = true
    this.emit('render-process-gone')
  }
}

function createClock(): {
  delay: (ms: number) => Promise<void>
  flush: (maxMs?: number) => void
} {
  const pending: Array<{ ms: number; resolve: () => void }> = []
  return {
    delay: (ms) => new Promise((resolve) => {
      pending.push({ ms, resolve })
    }),
    flush: (maxMs) => {
      const keep: typeof pending = []
      for (const item of pending.splice(0)) {
        if (maxMs === undefined || item.ms <= maxMs) item.resolve()
        else keep.push(item)
      }
      pending.push(...keep)
    }
  }
}

function createHarness(
  guests: Map<number, FakeGuest>,
  control?: BrowserPageControl,
  extras?: {
    previewGrants?: PreviewGrantStore
    readDisplayScale?: () => number | null
  }
): {
  host: BrowserSessionHost
  snapshots: BrowserSurfaceSnapshot[]
  mounts: BrowserGuestMountSnapshot[]
  clock: ReturnType<typeof createClock>
} {
  const clock = createClock()
  const snapshots: BrowserSurfaceSnapshot[] = []
  const mounts: BrowserGuestMountSnapshot[] = []
  const host = createBrowserSessionHost({
    resolveWorkspaceKey: (sessionId) => (sessionId.startsWith('sess') ? 'ws_a' : null),
    lookupGuest: (id) => guests.get(id),
    delay: clock.delay,
    control,
    previewGrants: extras?.previewGrants,
    readDisplayScale: extras?.readDisplayScale,
    onSnapshot: (snapshot) => {
      snapshots.push(snapshot)
    },
    onGuestMount: (snapshot) => {
      mounts.push(snapshot)
    }
  })
  return { host, snapshots, mounts, clock }
}

async function openReady(
  harness: ReturnType<typeof createHarness>,
  webContentsId: number,
  url = 'https://example.com/app'
): Promise<string> {
  const opening = harness.host.open({ url }, { sessionId: 'sess_1' })
  await Promise.resolve()
  const browserId = latestBrowserId(harness.snapshots)
  const attached = await harness.host.attach({
    sessionId: 'sess_1',
    browserId,
    webContentsId
  })
  expect(attached.status).toBe('applied')
  const opened = await opening
  expect(opened.status).toBe('applied')
  return browserId
}

describe('BrowserSessionHost 生命周期', () => {
  it('程序化打开、隐藏、恢复、关闭，关闭后确认 destroyed', async () => {
    const guest = new FakeGuest({ id: 2, url: 'https://example.com/app' })
    const harness = createHarness(new Map([[2, guest]]))
    const browserId = await openReady(harness, 2)
    expect(latestLifecycle(harness.snapshots, browserId)).toBe('ready')
    expect(harness.mounts.at(-1)?.guests[0]).toMatchObject({
      browserId,
      src: 'https://example.com/app',
      visible: true
    })
    expect(harness.host.inspectBinding(browserId)).toMatchObject({
      webContentsId: 2,
      type: 'webview',
      destroyed: false
    })

    expect(await harness.host.hide(browserId, 'sess_1')).toMatchObject({
      status: 'applied',
      page: { lifecycle: 'hidden' }
    })
    expect(harness.mounts.at(-1)?.guests[0]?.visible).toBe(false)

    expect(await harness.host.restore(browserId, 'sess_1')).toMatchObject({
      status: 'applied',
      page: { lifecycle: 'ready' }
    })

    const closing = harness.host.close({ browserId }, { sessionId: 'sess_1' })
    await Promise.resolve()
    await Promise.resolve()
    harness.clock.flush(1000)
    await Promise.resolve()
    expect(harness.mounts.at(-1)?.guests).toEqual([])
    guest.destroy()
    await expect(closing).resolves.toEqual({ status: 'applied', browserId })
    expect(harness.host.inspectBinding(browserId)).toBeNull()
    expect(guest.destroyed).toBe(true)
  })

  it('getType 不是 webview 时 fail closed，不绑定', async () => {
    const guest = new FakeGuest({ id: 7, type: 'window' })
    const harness = createHarness(new Map([[7, guest]]))
    const opening = harness.host.open({ url: 'https://example.com' }, { sessionId: 'sess_1' })
    await Promise.resolve()
    const browserId = latestBrowserId(harness.snapshots)
    const attached = await harness.host.attach({
      sessionId: 'sess_1',
      browserId,
      webContentsId: 7
    })
    expect(attached).toMatchObject({ status: 'not_applied', code: 'unavailable' })
    expect(harness.host.inspectBinding(browserId)?.webContentsId).toBeNull()
    void opening
  })

  it('崩溃按 pending 收敛 → detach → 确认后才换代', async () => {
    const guest = new FakeGuest({ id: 3, debuggerAttached: true })
    const harness = createHarness(new Map([[3, guest]]))
    const browserId = await openReady(harness, 3, 'https://example.com')
    expect(harness.host.inspectBinding(browserId)?.generation).toBe(1)
    guest.crash()
    harness.clock.flush(1000)
    await Promise.resolve()
    await Promise.resolve()
    expect(guest.debuggerAttached).toBe(false)
    expect(harness.host.inspectBinding(browserId)).toMatchObject({
      lifecycle: 'crashed',
      debuggerAttached: false,
      generation: 2
    })
  })

  it('debugger 仍 attached 时拒绝换代', async () => {
    const guest = new FakeGuest({
      id: 4,
      debuggerAttached: true,
      detachImpl: () => {
        /* 保持 attached */
      }
    })
    const harness = createHarness(new Map([[4, guest]]))
    const browserId = await openReady(harness, 4, 'https://example.com')
    guest.crash()
    harness.clock.flush(1000)
    await Promise.resolve()
    await Promise.resolve()
    expect(guest.debuggerAttached).toBe(true)
    expect(harness.host.inspectBinding(browserId)).toMatchObject({
      lifecycle: 'crashed',
      generation: 1,
      debuggerAttached: true
    })
  })

  it('renderer reload 后必须用新的 webContentsId 重绑', async () => {
    const first = new FakeGuest({ id: 2 })
    const second = new FakeGuest({ id: 3 })
    const harness = createHarness(new Map([[2, first], [3, second]]))
    const browserId = await openReady(harness, 2, 'https://example.com')
    expect(harness.host.inspectBinding(browserId)?.webContentsId).toBe(2)

    first.destroy()
    harness.host.noteRendererReloading()
    expect(harness.host.inspectBinding(browserId)).toMatchObject({
      webContentsId: null,
      lifecycle: 'opening'
    })

    const rebound = await harness.host.attach({
      sessionId: 'sess_1',
      browserId,
      webContentsId: 3
    })
    expect(rebound).toMatchObject({
      status: 'applied',
      page: { browserId, lifecycle: 'ready' }
    })
    expect(harness.host.inspectBinding(browserId)?.webContentsId).toBe(3)

    const stolen = await harness.host.attach({
      sessionId: 'sess_1',
      browserId,
      webContentsId: 2
    })
    expect(stolen.status).toBe('not_applied')
    expect(harness.host.inspectBinding(browserId)?.webContentsId).toBe(3)
  })

  it('弹窗只记在来源页上，确认时页面身份变了就不再打开', async () => {
    const harness = createHarness(new Map([
      [11, new FakeGuest({ id: 11 })],
      [12, new FakeGuest({ id: 12 })]
    ]))
    const id1 = await openReady(harness, 11, 'https://example.com/one')
    const second = harness.host.open({ url: 'https://example.com/two' }, { sessionId: 'sess_1' })
    await Promise.resolve()
    const id2 = harness.snapshots.at(-1)?.pages.find((page) => page.browserId !== id1)?.browserId
    expect(id2).toBeTruthy()
    await harness.host.attach({ sessionId: 'sess_1', browserId: id2!, webContentsId: 12 })
    await second
    harness.host.handlePopup('https://example.com/three', 12)
    harness.host.handlePopup('file:///tmp/x', 11)
    const pages = harness.snapshots.at(-1)?.pages ?? []
    const source = pages.find((page) => page.browserId === id2)
    const other = pages.find((page) => page.browserId === id1)
    expect(source?.notice).toMatchObject({
      kind: 'popup',
      sourceUrl: 'https://example.com',
      targetUrl: 'https://example.com/three'
    })
    expect(other?.notice?.targetUrl).toBeNull()
    expect(pages).toHaveLength(2)
    const opened = await harness.host.navigate(
      { browserId: id2!, action: { kind: 'accept-popup' } },
      { sessionId: 'sess_1' }
    )
    expect(opened.status).toBe('applied')
    if (opened.status === 'applied') expect(opened.page.url).toBe('https://example.com/three')
    harness.host.handlePopup('https://example.com/four', 12)
    await harness.host.claim({ browserId: id2! }, { sessionId: 'sess_1' })
    const stale = await harness.host.navigate(
      { browserId: id2!, action: { kind: 'accept-popup' } },
      { sessionId: 'sess_1' }
    )
    expect(stale).toMatchObject({ status: 'not_applied', code: 'stale_observation' })
  })

  it('关闭后释放隔离槽，清理失败则不能把旧槽发给新页', async () => {
    const guests = new Map<number, FakeGuest>([
      [21, new FakeGuest({ id: 21 })],
      [22, new FakeGuest({ id: 22 })]
    ])
    const cleaned: string[] = []
    let failCleanup = false
    const pool = (await import('../../../../src/main/browser/partitionSlots')).createBrowserPartitionSlotPool(
      async (partition) => {
        if (failCleanup) throw new Error('cleanup failed')
        cleaned.push(partition)
      }
    )
    const clock = createClock()
    const snapshots: BrowserSurfaceSnapshot[] = []
    const host = createBrowserSessionHost({
      resolveWorkspaceKey: () => 'ws_a',
      lookupGuest: (id) => guests.get(id),
      delay: clock.delay,
      onSnapshot: (snapshot) => {
        snapshots.push(snapshot)
      },
      allocatePartition: (browserId) => {
        const got = pool.acquire(browserId)
        if (!got.ok) return { error: 'resource_limit' }
        return { partition: got.partition }
      },
      releasePartition: async (browserId) => {
        await pool.release(browserId)
      }
    })
    const opening = host.open({ url: 'https://example.com/a' }, { sessionId: 'sess_1' })
    await Promise.resolve()
    const browserId = snapshots.at(-1)?.pages[0]?.browserId
    expect(browserId).toBeTruthy()
    await host.attach({ sessionId: 'sess_1', browserId: browserId!, webContentsId: 21 })
    await opening
    const partition = pool.inspect()[0]?.partition
    expect(partition).toBeDefined()
    expect(pool.inspect()[0]?.ownerBrowserId).toBe(browserId)

    const closing = host.close({ browserId: browserId! }, { sessionId: 'sess_1' })
    await Promise.resolve()
    await Promise.resolve()
    clock.flush(1000)
    await Promise.resolve()
    guests.get(21)?.destroy()
    await closing
    expect(cleaned).toEqual([partition])
    expect(pool.inspect()[0]?.state).toBe('idle')

    failCleanup = true
    const opening2 = host.open({ url: 'https://example.com/b' }, { sessionId: 'sess_1' })
    await Promise.resolve()
    const browserId2 = snapshots.at(-1)?.pages.find((page) => page.lifecycle === 'opening')?.browserId
    expect(browserId2).toBeTruthy()
    await host.attach({ sessionId: 'sess_1', browserId: browserId2!, webContentsId: 22 })
    await opening2
    expect(pool.inspect()[0]?.ownerBrowserId).toBe(browserId2)
    const closing2 = host.close({ browserId: browserId2! }, { sessionId: 'sess_1' })
    await Promise.resolve()
    await Promise.resolve()
    clock.flush(1000)
    await Promise.resolve()
    guests.get(22)?.destroy()
    await closing2
    expect(pool.inspect()[0]?.state).toBe('unusable')
    const third = host.open({ url: 'https://example.com/c' }, { sessionId: 'sess_1' })
    await Promise.resolve()
    const browserId3 = snapshots.at(-1)?.pages.find((page) => page.browserId !== browserId2)?.browserId
    expect(browserId3).toBeTruthy()
    expect(pool.inspect()[1]?.ownerBrowserId).toBe(browserId3)
    expect(pool.inspect()[1]?.partition).toBeDefined()
    expect(pool.inspect()[0]?.state).toBe('unusable')
    clock.flush(15_000)
    await expect(third).resolves.toMatchObject({ status: 'not_applied', code: 'timeout' })
  })

  it('挂载超时后拒绝迟到绑定，关闭失败页才释放槽', async () => {
    const guest = new FakeGuest({ id: 31 })
    const harness = createHarness(new Map([[31, guest]]))
    const opening = harness.host.open({ url: 'https://example.com/late' }, { sessionId: 'sess_1' })
    await Promise.resolve()
    const browserId = latestBrowserId(harness.snapshots)
    harness.clock.flush(15_000)
    await expect(opening).resolves.toMatchObject({ status: 'not_applied', code: 'timeout' })
    expect(latestLifecycle(harness.snapshots, browserId)).toBe('failed')
    expect(harness.host.livePageCount()).toBe(1)

    const late = await harness.host.attach({
      sessionId: 'sess_1',
      browserId,
      webContentsId: 31
    })
    expect(late).toMatchObject({ status: 'not_applied', code: 'unavailable' })
    expect(latestLifecycle(harness.snapshots, browserId)).toBe('failed')
    expect(harness.host.inspectBinding(browserId)?.webContentsId).toBeNull()

    const second = harness.host.open({ url: 'https://example.com/other' }, { sessionId: 'sess_1' })
    await Promise.resolve()
    expect(harness.host.livePageCount()).toBe(2)

    const closing = harness.host.close({ browserId }, { sessionId: 'sess_1' })
    await Promise.resolve()
    await Promise.resolve()
    harness.clock.flush(1000)
    await expect(closing).resolves.toEqual({ status: 'applied', browserId })
    expect(harness.host.inspectBinding(browserId)).toBeNull()
    expect(harness.host.livePageCount()).toBe(1)
    harness.clock.flush(15_000)
    await second
  })

  it('page-favicon-updated 投影 URL；主 frame 致命错误进 loadError，子资源与中止忽略', async () => {
    const guest = new FakeGuest({ id: 41, url: 'https://example.com/app' })
    const harness = createHarness(new Map([[41, guest]]))
    const browserId = await openReady(harness, 41, 'https://example.com/app')

    guest.emit('page-favicon-updated', {}, ['https://example.com/favicon.ico'])
    expect(latestPage(harness.snapshots, browserId)?.faviconUrl).toBe('https://example.com/favicon.ico')

    guest.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://missing.test/img.png', false)
    expect(latestPage(harness.snapshots, browserId)?.loadError).toBeNull()

    guest.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'https://example.com/app', true)
    expect(latestPage(harness.snapshots, browserId)?.loadError).toBeNull()

    guest.emit('did-fail-load', {}, -201, 'ERR_CERT_DATE_INVALID', 'https://bad-cert.test/', true)
    expect(latestPage(harness.snapshots, browserId)).toMatchObject({
      url: 'https://bad-cert.test/',
      loading: false,
      loadError: {
        errorCode: -201,
        message: 'ERR_CERT_DATE_INVALID',
        url: 'https://bad-cert.test/',
        isCertificateError: true
      }
    })

    guest.emit('did-start-loading')
    expect(latestPage(harness.snapshots, browserId)?.loadError).toBeNull()
    expect(latestPage(harness.snapshots, browserId)?.loading).toBe(true)
  })

  it('第三页打开被拒绝并提示最多两个页面', async () => {
    const harness = createHarness(new Map([
      [51, new FakeGuest({ id: 51 })],
      [52, new FakeGuest({ id: 52 })]
    ]))
    await openReady(harness, 51, 'https://example.com/one')
    const second = harness.host.open({ url: 'https://example.com/two' }, { sessionId: 'sess_1' })
    await Promise.resolve()
    const id2 = harness.snapshots.at(-1)?.pages.find((page) => page.url.includes('/two'))?.browserId
    expect(id2).toBeTruthy()
    await harness.host.attach({ sessionId: 'sess_1', browserId: id2!, webContentsId: 52 })
    await second
    await expect(harness.host.open({ url: 'https://example.com/three' }, { sessionId: 'sess_1' })).resolves.toMatchObject({
      status: 'not_applied',
      code: 'resource_limit',
      detail: '最多同时两个页面'
    })
  })

  it('未装配控制端口时观察返回未装配，而不是抛错', async () => {
    const harness = createHarness(new Map([[3, new FakeGuest({ id: 3 })]]))
    const browserId = await openReady(harness, 3)
    await expect(harness.host.observe({ browserId }, { sessionId: 'sess_1' })).resolves.toMatchObject({
      status: 'not_applied',
      code: 'unsupported'
    })
  })

  it('观察进行中被接管后，迟到结果不会记成已应用', async () => {
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let markEntered = (): void => {}
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve
    })
    const control: BrowserPageControl = {
      observe: async (_guest, fence) => {
        markEntered()
        await gate
        const current = fence.stillCurrent()
        if (!current.ok) return { status: 'not_applied', code: current.code, detail: '过期' }
        return {
          status: 'applied',
          read: {
            snapshot: {
              url: 'https://example.com/app',
              title: 'late',
              truncated: false,
              viewport: {
                width: 800,
                height: 600,
                device: 'desktop',
                deviceScaleFactor: 1,
                simulated: false,
                displayScale: null
              },
              dom: '- heading "late"',
              elements: [],
              limits: []
            },
            refs: {}
          }
        }
      },
      act: async () => ({ status: 'not_applied', code: 'unavailable', detail: '无' }),
      capture: async () => ({ status: 'not_applied', code: 'unavailable', detail: '无' }),
      load: async () => ({ status: 'applied' }),
      bindRefs: () => {},
      release: () => {}
    }
    const harness = createHarness(new Map([[4, new FakeGuest({ id: 4 })]]), control)
    const browserId = await openReady(harness, 4)
    const pending = harness.host.observe({ browserId }, { sessionId: 'sess_1' })
    await entered
    await harness.host.claim({ browserId }, { sessionId: 'sess_1' })
    release()
    await expect(pending).resolves.toMatchObject({ status: 'not_applied', code: 'taken_over' })
  })

  it('动作进行中被接管后，已发出的结果不会写回当前页', async () => {
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let markEntered = (): void => {}
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve
    })
    const harness = createHarness(new Map([[12, new FakeGuest({ id: 12 })]]), {
      ...immediateControl(),
      act: async (_guest, fence) => {
        markEntered()
        await gate
        const current = fence.stillCurrent()
        if (!current.ok) return { status: 'not_applied', code: current.code, detail: '过期' }
        return { status: 'applied', summary: 'clicked' }
      }
    })
    const browserId = await openReady(harness, 12)
    const observed = await harness.host.observe({ browserId }, agentContext())
    expect(observed.status).toBe('applied')
    if (observed.status !== 'applied') return
    const pending = harness.host.act(
      { observation: observed.observation, action: { kind: 'click', ref: 'e1' } },
      agentContext()
    )
    await entered
    await harness.host.claim({ browserId }, { sessionId: 'sess_1' })
    release()
    await expect(pending).resolves.toMatchObject({
      status: 'not_applied',
      code: 'taken_over'
    })
  })

  it('待执行超过四个时，后续代理命令返回 busy', async () => {
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let markEntered = (): void => {}
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve
    })
    const harness = createHarness(new Map([[8, new FakeGuest({ id: 8 })]]), gatedControl(gate, markEntered))
    const browserId = await openReady(harness, 8)
    const ctx = agentContext()
    const first = harness.host.observe({ browserId }, ctx)
    await entered
    const queued = [0, 1, 2, 3].map(() => harness.host.observe({ browserId }, ctx))
    await expect(harness.host.observe({ browserId }, ctx)).resolves.toMatchObject({
      status: 'not_applied',
      code: 'busy'
    })
    release()
    await expect(first).resolves.toMatchObject({ status: 'applied' })
    await Promise.all(queued)
  })

  it('取消会拒绝待执行，并让进行中的观察以 cancelled 结束', async () => {
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let markEntered = (): void => {}
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve
    })
    const harness = createHarness(new Map([[9, new FakeGuest({ id: 9 })]]), gatedControl(gate, markEntered))
    const browserId = await openReady(harness, 9)
    const ctx = agentContext()
    const inFlight = harness.host.observe({ browserId }, ctx)
    await entered
    const pending = harness.host.observe({ browserId }, ctx)
    harness.host.cancelRun('run_1')
    await expect(pending).resolves.toMatchObject({ status: 'not_applied', code: 'cancelled' })
    release()
    await expect(inFlight).resolves.toMatchObject({ status: 'not_applied', code: 'cancelled' })
    expect(latestPage(harness.snapshots, browserId)?.lifecycle).toBe('ready')
  })

  it('关闭进行中的观察会结束命令且页面关掉', async () => {
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let markEntered = (): void => {}
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve
    })
    const guest = new FakeGuest({ id: 12 })
    const harness = createHarness(new Map([[12, guest]]), gatedControl(gate, markEntered))
    const browserId = await openReady(harness, 12)
    const inFlight = harness.host.observe({ browserId }, agentContext())
    await entered
    const closing = harness.host.close({ browserId }, { sessionId: 'sess_1' })
    release()
    const observed = await inFlight
    expect(observed.status).toBe('not_applied')
    if (observed.status === 'not_applied') {
      expect(['page_closed', 'cancelled']).toContain(observed.code)
    }
    harness.clock.flush(1000)
    guest.destroy()
    await expect(closing).resolves.toEqual({ status: 'applied', browserId })
  })

  it('用户导航会提升 generation；代理导航只取得租约', async () => {
    const harness = createHarness(new Map([[10, new FakeGuest({ id: 10 })]]))
    const browserId = await openReady(harness, 10)
    const before = harness.host.inspectBinding(browserId)?.generation
    expect(before).toBe(1)
    await harness.host.navigate({ browserId, action: { kind: 'reload' } }, { sessionId: 'sess_1' })
    expect(harness.host.inspectBinding(browserId)?.generation).toBe(2)
    expect(latestPage(harness.snapshots, browserId)?.control).toEqual({ holder: 'user' })

    await harness.host.navigate(
      { browserId, action: { kind: 'reload' } },
      agentContext()
    )
    expect(harness.host.inspectBinding(browserId)?.generation).toBe(2)
    expect(latestPage(harness.snapshots, browserId)?.control).toEqual({
      holder: 'agent',
      runId: 'run_1'
    })
  })

  it('轮次结束释放租约但页面保留；会话切换撤销控制', async () => {
    const harness = createHarness(new Map([[11, new FakeGuest({ id: 11 })]]), immediateControl())
    const browserId = await openReady(harness, 11)
    await harness.host.observe({ browserId }, agentContext())
    expect(latestPage(harness.snapshots, browserId)?.control).toEqual({
      holder: 'agent',
      runId: 'run_1'
    })
    harness.host.releaseAgent('run_1')
    expect(latestPage(harness.snapshots, browserId)?.control).toEqual({ holder: 'none' })
    expect(latestLifecycle(harness.snapshots, browserId)).toBe('ready')

    const generation = harness.host.inspectBinding(browserId)?.generation
    harness.host.revokeSession('sess_1')
    expect(harness.host.inspectBinding(browserId)?.generation).toBe((generation ?? 0) + 1)
    expect(latestPage(harness.snapshots, browserId)?.control).toEqual({ holder: 'none' })
    expect(latestLifecycle(harness.snapshots, browserId)).toBe('ready')
  })

  it('云元数据地址不能打开，也不会占用页面名额', async () => {
    const harness = createHarness(new Map())
    const opened = await harness.host.open(
      { url: 'http://169.254.169.254/latest/meta-data' },
      { sessionId: 'sess_1' }
    )
    expect(opened).toMatchObject({ status: 'not_applied', code: 'invalid_request' })
    expect(harness.host.livePageCount()).toBe(0)
  })

  it('观察结果带上显示器缩放', async () => {
    const harness = createHarness(
      new Map([[21, new FakeGuest({ id: 21 })]]),
      immediateControl(),
      { readDisplayScale: () => 1.5 }
    )
    const browserId = await openReady(harness, 21)
    const observed = await harness.host.observe({ browserId }, { sessionId: 'sess_1' })
    expect(observed.status).toBe('applied')
    if (observed.status !== 'applied') return
    expect(observed.snapshot.viewport).toMatchObject({
      width: 800,
      height: 600,
      deviceScaleFactor: 1,
      simulated: false,
      displayScale: 1.5
    })
  })

  it('接管后旧的视口恢复不会再写到页面上', async () => {
    const applied: string[] = []
    const harness = createHarness(new Map([[22, new FakeGuest({ id: 22 })]]), {
      ...immediateControl(),
      act: async (_guest, fence, action) => {
        const current = fence.stillCurrent()
        if (!current.ok) return { status: 'not_applied', code: current.code, detail: '过期' }
        if (action.kind === 'viewport') applied.push(`${action.width}x${action.height}`)
        return { status: 'applied', summary: 'viewport' }
      }
    })
    const browserId = await openReady(harness, 22)
    const observed = await harness.host.observe({ browserId }, agentContext())
    expect(observed.status).toBe('applied')
    if (observed.status !== 'applied') return
    const set = await harness.host.act(
      {
        observation: observed.observation,
        action: { kind: 'viewport', width: 390, height: 844, device: 'mobile' }
      },
      agentContext()
    )
    expect(set.status).toBe('applied')
    await harness.host.claim({ browserId }, { sessionId: 'sess_1' })
    const restore = await harness.host.act(
      {
        observation: observed.observation,
        action: { kind: 'viewport', width: 1280, height: 800, device: 'desktop' }
      },
      agentContext()
    )
    expect(restore).toMatchObject({ status: 'not_applied', code: 'taken_over' })
    expect(applied).toEqual(['390x844'])
  })

  it('关掉预览页不会终止已绑定的开发服务器', async () => {
    const registry = new ProcessRegistry({ terminateTimeoutMs: 20 })
    let kills = 0
    const child = {
      exitCode: null as number | null,
      signalCode: null as string | null,
      once() {}
    }
    const handle = registry.register({
      owner: { sessionId: 'sess_1', runId: 'run_1' },
      source: 'main-run',
      command: 'vite http://127.0.0.1:5173',
      workdir: 'D:/workspace',
      destructive: false,
      seedOutput: '',
      killTree: async () => {
        kills += 1
      },
      writeStdin: async () => {},
      child,
      checkpointBaseline: null
    })
    const grants = createPreviewGrantStore({
      findRunning: (sessionId, origin) => findOwnedPreviewRef(registry.listRunning(sessionId), origin)
    })
    const guest = new FakeGuest({ id: 23, url: 'http://127.0.0.1:5173/' })
    const harness = createHarness(new Map([[23, guest]]), undefined, { previewGrants: grants })
    const browserId = await openReady(harness, 23, 'http://127.0.0.1:5173/')
    expect(grants.inspect()).toEqual([
      expect.objectContaining({
        origin: 'http://127.0.0.1:5173',
        sessionId: 'sess_1',
        workspaceKey: 'ws_a',
        processRef: handle.ref
      })
    ])
    const closing = harness.host.close({ browserId }, { sessionId: 'sess_1' })
    await Promise.resolve()
    harness.clock.flush(1000)
    await Promise.resolve()
    guest.destroy()
    await expect(closing).resolves.toMatchObject({ status: 'applied' })
    expect(kills).toBe(0)
    expect(registry.describe(handle.ref, 'sess_1').state).toBe('running')
  })
})

function latestBrowserId(snapshots: BrowserSurfaceSnapshot[]): string {
  const page = snapshots.at(-1)?.pages[0]
  if (!page) throw new Error('没有页面快照')
  return page.browserId
}

function latestLifecycle(
  snapshots: BrowserSurfaceSnapshot[],
  browserId: string
): string | undefined {
  return latestPage(snapshots, browserId)?.lifecycle
}

function latestPage(
  snapshots: BrowserSurfaceSnapshot[],
  browserId: string
) {
  return snapshots.at(-1)?.pages.find((page) => page.browserId === browserId)
}

function agentContext(runId = 'run_1'): BrowserCommandContext {
  return {
    sessionId: 'sess_1',
    authority: {
      sessionId: 'sess_1',
      runId,
      resourceOwnerRunId: runId,
      toolCallId: 'call_1'
    }
  }
}

function appliedRead() {
  return {
    status: 'applied' as const,
    read: {
      snapshot: {
        url: 'https://example.com/app',
        title: 'ok',
        truncated: false,
        viewport: {
          width: 800,
          height: 600,
          device: 'desktop' as const,
          deviceScaleFactor: 1,
          simulated: false,
          displayScale: null
        },
        dom: '- heading "ok"',
        elements: [],
        limits: []
      },
      refs: {}
    }
  }
}

function immediateControl(): BrowserPageControl {
  return {
    observe: async (_guest, fence) => {
      const current = fence.stillCurrent()
      if (!current.ok) return { status: 'not_applied', code: current.code, detail: '过期' }
      return appliedRead()
    },
    act: async () => ({ status: 'not_applied', code: 'unavailable', detail: '无' }),
    capture: async () => ({ status: 'not_applied', code: 'unavailable', detail: '无' }),
    load: async () => ({ status: 'applied' }),
    bindRefs: () => {},
    release: () => {}
  }
}

function gatedControl(gate: Promise<void>, markEntered: () => void): BrowserPageControl {
  return {
    observe: async (_guest, fence) => {
      markEntered()
      await gate
      const current = fence.stillCurrent()
      if (!current.ok) return { status: 'not_applied', code: current.code, detail: '过期' }
      return appliedRead()
    },
    act: async () => ({ status: 'not_applied', code: 'unavailable', detail: '无' }),
    capture: async () => ({ status: 'not_applied', code: 'unavailable', detail: '无' }),
    load: async () => ({ status: 'applied' }),
    bindRefs: () => {},
    release: () => {}
  }
}
