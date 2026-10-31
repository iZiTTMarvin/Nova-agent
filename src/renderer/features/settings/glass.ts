import type { PointerEvent } from 'react'

/** 玻璃悬停高光已改由纯 CSS 合成器 opacity 驱动，保留空实现以兼容调用方，避免 pointermove 触发同步布局与渐变重绘 */
export function trackSheen(_e: PointerEvent<HTMLElement>): void {
  // no-op
}
