/**
 * 系统通知集成层：snapshot 差异检测与策略门禁在 shared 纯函数里，
 * 这里只负责 Electron Notification 展示、点击聚焦与跳转路由。
 * E2E 环境注入 NOVA_E2E=1 抑制，防止测试弹真通知。
 */
import { BrowserWindow, Notification } from 'electron'
import type { RunSnapshot } from '../shared/run/types'
import {
  detectRunNotificationTrigger,
  describeRunNotification,
  shouldShowNotification
} from '../shared/notifications/runNotificationCopy'
import { loadNovaSettings } from '../runtime/settings/novaSettings'

/** 每个 run 的上一份快照；仅在进程内存，重启即清零 */
const lastSnapshots = new Map<string, RunSnapshot>()

let getMainWindowRef: (() => BrowserWindow | null) | null = null
let sessionTitleLookup: ((sessionId: string) => string | undefined) | null = null

export function initNotifications(
  getMainWindow: () => BrowserWindow | null,
  lookupSessionTitle: (sessionId: string) => string | undefined
): void {
  getMainWindowRef = getMainWindow
  sessionTitleLookup = lookupSessionTitle
}

/**
 * snapshot 广播钩子：由 RunCoordinatorHost 在广播前调用。
 * 通知的成败不影响广播路径。
 */
export function notifyOnSnapshot(snapshot: RunSnapshot): void {
  const prev = lastSnapshots.get(snapshot.runId) ?? null
  lastSnapshots.set(snapshot.runId, snapshot)
  // 有界：只保留近期 run 的状态，避免长会话进程内存无限增长
  if (lastSnapshots.size > 64) {
    for (const key of lastSnapshots.keys()) {
      if (lastSnapshots.size <= 64) break
      lastSnapshots.delete(key)
    }
  }

  try {
    const trigger = detectRunNotificationTrigger(prev, snapshot)
    if (!trigger) return
    const win = getMainWindowRef?.() ?? null
    const settings = loadNovaSettings()
    const isSubagent = Boolean(
      snapshot.dispatch || snapshot.sessionId.startsWith('sess_sub_')
    )
    const allowed = shouldShowNotification({
      enabled: settings.notificationsEnabled,
      supported: Notification.isSupported(),
      windowFocused: win?.isFocused() ?? false,
      onlyWhenUnfocused: settings.notifyOnlyWhenUnfocused,
      e2e: process.env.NOVA_E2E === '1',
      isSubagent
    })
    if (!allowed) return

    const copy = describeRunNotification(trigger, snapshot, sessionTitleLookup?.(snapshot.sessionId))
    const notification = new Notification({ title: copy.title, body: copy.body })
    notification.on('click', () => {
      const target = getMainWindowRef?.() ?? null
      if (!target || target.isDestroyed()) return
      if (target.isMinimized()) target.restore()
      target.focus()
      // 跳转到对应会话由 renderer 执行（会话选择是 renderer 状态）
      if (!target.webContents.isDestroyed()) {
        target.webContents.send('notifications:navigate', { sessionId: snapshot.sessionId })
      }
    })
    notification.show()
  } catch {
    // 通知失败不影响主路径
  }
}
