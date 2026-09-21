import { describe, expect, it } from 'vitest'
import {
  createBrowserSessionHost,
  type BrowserSessionHost
} from '../../../../src/main/browser/sessionHost'
import type { BrowserGuestContents, BrowserGuestEvent } from '../../../../src/main/browser/guestContents'
import type { BrowserGuestMountSnapshot, BrowserSurfaceSnapshot } from '../../../../src/shared/browser'

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
    detach: (): void => {
      this.detachImpl()
    }
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

function createHarness(guests: Map<number, FakeGuest>): {
  host: BrowserSessionHost
  snapshots: BrowserSurfaceSnapshot[]
  mounts: BrowserGuestMountSnapshot[]
  externals: string[]
  clock: ReturnType<typeof createClock>
} {
  const clock = createClock()
  const snapshots: BrowserSurfaceSnapshot[] = []
  const mounts: BrowserGuestMountSnapshot[] = []
  const externals: string[] = []
  const host = createBrowserSessionHost({
    resolveWorkspaceKey: (sessionId) => (sessionId.startsWith('sess') ? 'ws_a' : null),
    lookupGuest: (id) => guests.get(id),
    openExternal: (url) => {
      externals.push(url)
    },
    delay: clock.delay,
    onSnapshot: (snapshot) => {
      snapshots.push(snapshot)
    },
    onGuestMount: (snapshot) => {
      mounts.push(snapshot)
    }
  })
  return { host, snapshots, mounts, externals, clock }
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

  it('满员弹窗走系统浏览器，不新开窗口', async () => {
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
    harness.host.handlePopup('https://example.com/three', 'sess_1')
    expect(harness.externals).toEqual(['https://example.com/three'])
    harness.host.handlePopup('file:///tmp/x', 'sess_1')
    expect(harness.externals).toEqual(['https://example.com/three'])
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
      openExternal: () => {},
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
  return snapshots.at(-1)?.pages.find((page) => page.browserId === browserId)?.lifecycle
}
