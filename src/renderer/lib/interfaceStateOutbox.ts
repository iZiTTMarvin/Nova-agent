/**
 * 界面状态待发箱：用户在回答里的交互组件上调过的值，等下一条用户消息一起交给模型。
 *
 * 每个会话按组件保留最近一次快照；发送路径在发出前 claim 整份报告，
 * 确认未送达时 release 放回（不覆盖期间产生的更新）。只在 Renderer 内存里，不落盘：
 * 已发出的报告随投递事实进入会话历史，未发出的改动重启后不再追溯。
 */
import {
  MAX_INTERFACE_STATE_WIDGETS,
  type InterfaceStateReport,
  type InterfaceStateWidget
} from '../../shared/visualization/interfaceState'

const pending = new Map<string, Map<string, InterfaceStateWidget>>()

export interface InterfaceStateClaim {
  readonly report: InterfaceStateReport
  /** 确认未送达时调用：把这次取走的条目放回，期间已有更新的组件保留更新 */
  release(): void
}

export function recordInterfaceState(sessionId: string, widgetKey: string, widget: InterfaceStateWidget): void {
  let widgets = pending.get(sessionId)
  if (!widgets) {
    widgets = new Map()
    pending.set(sessionId, widgets)
  }
  // 重新插入让最近调过的组件排在最后，超限时先丢最久没动的
  widgets.delete(widgetKey)
  widgets.set(widgetKey, widget)
  while (widgets.size > MAX_INTERFACE_STATE_WIDGETS) {
    const oldest = widgets.keys().next().value
    if (oldest === undefined) break
    widgets.delete(oldest)
  }
}

export function claimInterfaceState(sessionId: string | null | undefined): InterfaceStateClaim | null {
  if (!sessionId) return null
  const widgets = pending.get(sessionId)
  if (!widgets || widgets.size === 0) return null
  const entries = [...widgets]
  pending.delete(sessionId)
  return {
    report: { widgets: entries.map(([, widget]) => widget) },
    release: () => {
      const current = pending.get(sessionId) ?? new Map<string, InterfaceStateWidget>()
      const merged = new Map(entries.filter(([key]) => !current.has(key)))
      for (const [key, widget] of current) merged.set(key, widget)
      pending.set(sessionId, merged)
    }
  }
}
