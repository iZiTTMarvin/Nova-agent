import type { PointerEvent } from 'react'

/** 玻璃高光跟随指针：直接写 CSS 变量，不触发 React 重渲染 */
export function trackSheen(e: PointerEvent<HTMLElement>): void {
  const rect = e.currentTarget.getBoundingClientRect()
  e.currentTarget.style.setProperty('--mx', `${e.clientX - rect.left}px`)
  e.currentTarget.style.setProperty('--my', `${e.clientY - rect.top}px`)
}
