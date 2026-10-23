/**
 * 界面状态回传：用户在回答里的交互组件上改过的值，随下一条用户消息交给模型。
 *
 * Renderer 只上报「组件标题 + 控件标签 = 当前值」，主进程在边界重新校验并截断；
 * 格式化后的提示只进入模型输入与投递事实，不显示在用户气泡里。
 */

export interface InterfaceStateValue {
  readonly label: string
  readonly value: string
}

export interface InterfaceStateWidget {
  readonly title: string
  /** 空数组表示该组件已恢复初始值 */
  readonly values: readonly InterfaceStateValue[]
}

export interface InterfaceStateReport {
  readonly widgets: readonly InterfaceStateWidget[]
}

export const MAX_INTERFACE_STATE_WIDGETS = 6
export const MAX_INTERFACE_STATE_VALUES = 12
const MAX_TITLE_CHARS = 60
const MAX_LABEL_CHARS = 40
const MAX_VALUE_CHARS = 120

function boundedText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const compact = value.replace(/\s+/g, ' ').trim()
  if (!compact) return null
  const chars = Array.from(compact)
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : compact
}

/** 边界解析：结构不对的条目丢弃，全部无效时返回 null；不抛异常。 */
export function parseInterfaceStateReport(raw: unknown): InterfaceStateReport | null {
  if (!raw || typeof raw !== 'object') return null
  const widgetsRaw = (raw as { widgets?: unknown }).widgets
  if (!Array.isArray(widgetsRaw)) return null
  const widgets: InterfaceStateWidget[] = []
  for (const entry of widgetsRaw.slice(0, MAX_INTERFACE_STATE_WIDGETS)) {
    if (!entry || typeof entry !== 'object') continue
    const title = boundedText((entry as { title?: unknown }).title, MAX_TITLE_CHARS)
    const valuesRaw = (entry as { values?: unknown }).values
    if (!title || !Array.isArray(valuesRaw)) continue
    const values: InterfaceStateValue[] = []
    for (const item of valuesRaw.slice(0, MAX_INTERFACE_STATE_VALUES)) {
      if (!item || typeof item !== 'object') continue
      const label = boundedText((item as { label?: unknown }).label, MAX_LABEL_CHARS)
      const value = boundedText((item as { value?: unknown }).value, MAX_VALUE_CHARS)
      if (label && value) values.push({ label, value })
    }
    widgets.push({ title, values })
  }
  return widgets.length > 0 ? { widgets } : null
}

/** 模型看到的附加说明；措辞固定，随投递事实落盘，重建请求时逐字复现。 */
export function formatInterfaceStateNote(report: InterfaceStateReport): string {
  const lines = report.widgets.map(widget => {
    const detail = widget.values.length > 0
      ? widget.values.map(item => `${item.label} = ${item.value}`).join('；')
      : '已恢复初始值'
    return `- 「${widget.title}」：${detail}`
  })
  return ['[界面状态] 用户在之前回答里的交互组件上做了调整（据此理解这条消息，不必复述）：', ...lines].join('\n')
}
