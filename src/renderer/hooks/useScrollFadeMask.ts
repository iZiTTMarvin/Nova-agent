/**
 * 滚动容器 7 档非线性边缘渐隐遮罩 Hook：
 * 直接在 DOM 节点上原地更新 `--scroll-fade-top` 与 `--scroll-fade-bottom`，
 * 避免滚动期间触发 React 状态重渲染。
 */
import { useEffect } from 'react'
import type { RefObject } from 'react'

export interface UseScrollFadeMaskOptions {
  /** 羽化边缘像素高度，默认 24px */
  fadeSize?: number
  /** 当传入容器为外层包装节点时，可通过选择器定位内部真实滚动节点 */
  selector?: string
  /** 是否启用遮罩测量，默认 true */
  enabled?: boolean
}

const EDGE_TOLERANCE_PX = 2

export function updateScrollFadeMaskVars(el: HTMLElement, fadeSize = 24): void {
  const { scrollTop, scrollHeight, clientHeight } = el
  const canScroll = scrollHeight - clientHeight > EDGE_TOLERANCE_PX
  const topPx = canScroll && scrollTop > EDGE_TOLERANCE_PX ? fadeSize : 0
  const bottomPx =
    canScroll && scrollTop + clientHeight < scrollHeight - EDGE_TOLERANCE_PX ? fadeSize : 0
  el.style.setProperty('--scroll-fade-top', `${topPx}px`)
  el.style.setProperty('--scroll-fade-bottom', `${bottomPx}px`)
}

function isRefObject(
  target: HTMLElement | null | RefObject<HTMLElement | null>
): target is RefObject<HTMLElement | null> {
  return target !== null && typeof target === 'object' && 'current' in target
}

export function useScrollFadeMask(
  target: HTMLElement | null | RefObject<HTMLElement | null>,
  options: UseScrollFadeMaskOptions = {}
): void {
  const { fadeSize = 24, selector, enabled = true } = options
  const directElement = isRefObject(target) ? null : target

  useEffect(() => {
    if (!enabled) return
    const baseEl = isRefObject(target) ? target.current : directElement
    if (!baseEl) return
    const scroller = selector ? baseEl.querySelector<HTMLElement>(selector) : baseEl
    if (!scroller) return

    scroller.classList.add('scroll-fade-y')
    const sync = () => updateScrollFadeMaskVars(scroller, fadeSize)
    sync()

    scroller.addEventListener('scroll', sync, { passive: true })

    let ro: ResizeObserver | null = null
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(sync)
      ro.observe(scroller)
      if (scroller.firstElementChild instanceof HTMLElement) {
        ro.observe(scroller.firstElementChild)
      }
    }

    return () => {
      scroller.removeEventListener('scroll', sync)
      ro?.disconnect()
    }
  }, [target, directElement, fadeSize, selector, enabled])
}
