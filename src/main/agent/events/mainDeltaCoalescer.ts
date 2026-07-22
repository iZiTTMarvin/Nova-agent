/**
 * 主进程 thinking/text delta IPC 合帧（8~16ms）
 *
 * 减少主进程 → renderer 的 IPC 条数；renderer 侧 streamDeltaBuffer 仍有 16ms 二次聚合。
 * 轮次边界事件（tool_call_start / tool_call / message_end / error / message_start）前强制 flush。
 */

import type { BrowserWindow } from 'electron'

const COALESCE_MS = 16

interface MessageDeltaBucket {
  thinking: string
  text: string
  /** 该消息归属的会话 id（随首条 delta 记录，flush 时透出，供 renderer 区分焦点/后台会话） */
  sessionId?: string
}

let buckets = new Map<string, MessageDeltaBucket>()
let flushTimer: ReturnType<typeof setTimeout> | null = null
let pendingWindow: BrowserWindow | null = null

function getBucket(messageId: string, sessionId?: string): MessageDeltaBucket {
  let bucket = buckets.get(messageId)
  if (!bucket) {
    bucket = { thinking: '', text: '', sessionId }
    buckets.set(messageId, bucket)
  }
  return bucket
}

function canSendToWindow(win: BrowserWindow | null): win is BrowserWindow {
  if (!win || win.isDestroyed()) return false
  if (win.webContents.isDestroyed()) return false
  return true
}

function sendCoalescedDeltas(win: BrowserWindow): void {
  if (!canSendToWindow(win)) {
    buckets.clear()
    return
  }

  const { webContents } = win
  for (const [messageId, bucket] of buckets) {
    if (bucket.thinking) {
      webContents.send('agent:thinking-delta', { messageId, delta: bucket.thinking, sessionId: bucket.sessionId })
    }
    if (bucket.text) {
      webContents.send('agent:text-delta', { messageId, delta: bucket.text, sessionId: bucket.sessionId })
    }
  }
  buckets.clear()
}

function scheduleFlush(win: BrowserWindow): void {
  pendingWindow = win
  if (flushTimer !== null) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    const target = pendingWindow
    pendingWindow = null
    if (target) {
      sendCoalescedDeltas(target)
    }
  }, COALESCE_MS)
  flushTimer.unref?.()
}

/** 立即 flush 所有待发 delta（轮次边界事件前调用） */
export function flushMainDeltaCoalescer(win: BrowserWindow | null): void {
  if (flushTimer !== null) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  pendingWindow = null
  if (win) {
    sendCoalescedDeltas(win)
  } else {
    buckets.clear()
  }
}

export function pushMainThinkingDelta(
  win: BrowserWindow | null,
  messageId: string,
  delta: string,
  sessionId?: string
): void {
  if (!delta || !canSendToWindow(win)) return
  getBucket(messageId, sessionId).thinking += delta
  scheduleFlush(win)
}

export function pushMainTextDelta(
  win: BrowserWindow | null,
  messageId: string,
  delta: string,
  sessionId?: string
): void {
  if (!delta || !canSendToWindow(win)) return
  getBucket(messageId, sessionId).text += delta
  scheduleFlush(win)
}

/** 测试重置内部状态 */
export function resetMainDeltaCoalescerForTests(): void {
  if (flushTimer !== null) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  pendingWindow = null
  buckets.clear()
}
