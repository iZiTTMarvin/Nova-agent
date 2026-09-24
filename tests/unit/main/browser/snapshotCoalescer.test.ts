import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  BROWSER_GUEST_MOUNT,
  BROWSER_SNAPSHOT
} from '../../../../src/shared/ipc/channels'
import {
  flushBrowserSnapshotCoalescer,
  pushBrowserGuestMountSnapshot,
  pushBrowserSurfaceSnapshot,
  resetBrowserSnapshotCoalescerForTests
} from '../../../../src/main/browser/snapshotCoalescer'
import type { BrowserGuestMountSnapshot, BrowserSurfaceSnapshot } from '../../../../src/shared/browser'

function makeWindow() {
  const send = vi.fn()
  return {
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      send
    },
    _send: send
  }
}

function snapshot(sequence: number): BrowserSurfaceSnapshot {
  return { sequence, pages: [], activeBrowserId: null, maxLivePages: 2 }
}

function guests(sequence: number): BrowserGuestMountSnapshot {
  return { sequence, guests: [] }
}

describe('browser snapshot coalescer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetBrowserSnapshotCoalescerForTests()
  })

  afterEach(() => {
    resetBrowserSnapshotCoalescerForTests()
    vi.useRealTimers()
  })

  it('16ms 内只发送最新一份快照', () => {
    const win = makeWindow()
    pushBrowserSurfaceSnapshot(win as never, snapshot(1))
    pushBrowserSurfaceSnapshot(win as never, snapshot(2))
    expect(win._send).not.toHaveBeenCalled()
    vi.advanceTimersByTime(16)
    expect(win._send).toHaveBeenCalledTimes(1)
    expect(win._send).toHaveBeenCalledWith(BROWSER_SNAPSHOT, { snapshot: snapshot(2) })
  })

  it('同一帧合并 guest 挂载与页面快照', () => {
    const win = makeWindow()
    pushBrowserSurfaceSnapshot(win as never, snapshot(3))
    pushBrowserGuestMountSnapshot(win as never, guests(3))
    vi.advanceTimersByTime(16)
    expect(win._send).toHaveBeenCalledTimes(2)
    expect(win._send).toHaveBeenNthCalledWith(1, BROWSER_SNAPSHOT, { snapshot: snapshot(3) })
    expect(win._send).toHaveBeenNthCalledWith(2, BROWSER_GUEST_MOUNT, { snapshot: guests(3) })
  })

  it('flush 立即发送并取消定时器', () => {
    const win = makeWindow()
    pushBrowserSurfaceSnapshot(win as never, snapshot(4))
    flushBrowserSnapshotCoalescer(win as never)
    expect(win._send).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(32)
    expect(win._send).toHaveBeenCalledTimes(1)
  })
})
