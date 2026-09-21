/**
 * 浏览器状态快照合帧（16ms，只保留最新一份）。
 * 加载/标题等高频小字段不逐条裸 send；生命周期变化仍在下一帧到达。
 */
import type { BrowserWindow } from 'electron'
import {
  BROWSER_GUEST_MOUNT,
  BROWSER_SNAPSHOT
} from '../../shared/ipc/channels'
import type {
  BrowserGuestMountSnapshot,
  BrowserSurfaceSnapshot
} from '../../shared/browser'

const COALESCE_MS = 16

let pendingWindow: BrowserWindow | null = null
let pendingSnapshot: BrowserSurfaceSnapshot | null = null
let pendingGuestMount: BrowserGuestMountSnapshot | null = null
let flushTimer: ReturnType<typeof setTimeout> | null = null

function canSendToWindow(win: BrowserWindow | null): win is BrowserWindow {
  if (!win || win.isDestroyed()) return false
  if (win.webContents.isDestroyed()) return false
  return true
}

function sendPending(win: BrowserWindow): void {
  if (!canSendToWindow(win)) {
    pendingSnapshot = null
    pendingGuestMount = null
    return
  }
  const { webContents } = win
  if (pendingSnapshot) {
    webContents.send(BROWSER_SNAPSHOT, { snapshot: pendingSnapshot })
    pendingSnapshot = null
  }
  if (pendingGuestMount) {
    webContents.send(BROWSER_GUEST_MOUNT, { snapshot: pendingGuestMount })
    pendingGuestMount = null
  }
}

function scheduleFlush(win: BrowserWindow): void {
  pendingWindow = win
  if (flushTimer !== null) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    const target = pendingWindow
    pendingWindow = null
    if (target) sendPending(target)
  }, COALESCE_MS)
  flushTimer.unref?.()
}

export function flushBrowserSnapshotCoalescer(win: BrowserWindow | null): void {
  if (flushTimer !== null) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  pendingWindow = null
  if (win) sendPending(win)
  else {
    pendingSnapshot = null
    pendingGuestMount = null
  }
}

export function pushBrowserSurfaceSnapshot(
  win: BrowserWindow | null,
  snapshot: BrowserSurfaceSnapshot
): void {
  if (!canSendToWindow(win)) return
  pendingSnapshot = snapshot
  scheduleFlush(win)
}

export function pushBrowserGuestMountSnapshot(
  win: BrowserWindow | null,
  snapshot: BrowserGuestMountSnapshot
): void {
  if (!canSendToWindow(win)) return
  pendingGuestMount = snapshot
  scheduleFlush(win)
}

export function resetBrowserSnapshotCoalescerForTests(): void {
  if (flushTimer !== null) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  pendingWindow = null
  pendingSnapshot = null
  pendingGuestMount = null
}
