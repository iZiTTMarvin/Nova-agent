/**
 * Inspector 宽度过渡（开合、切到浏览器标签放宽）的会话通知：开始时告知主区终态宽度变化量，
 * 播完或被打断时告知结束。连接方据此把相邻阅读柱一次性排到终态，过渡期间不逐帧重排。
 */
import { useLayoutEffect, useRef, type RefObject } from 'react'

export interface UseInspectorSlideOptions {
  shellRef: RefObject<HTMLElement | null>
  /** 外壳目标宽度（px） */
  width: number
  /** 拖拽期间宽度直写 DOM 且无过渡，不产生过渡会话 */
  dragging: boolean
  /** 开始传主区宽度变化量（px，正为变宽），结束传 null；二者成对 */
  onSlideChange?: (mainWidthDelta: number | null) => void
}

export function useInspectorSlide({ shellRef, width, dragging, onSlideChange }: UseInspectorSlideOptions): void {
  const previousWidth = useRef(width)
  const onSlideChangeRef = useRef(onSlideChange)
  onSlideChangeRef.current = onSlideChange

  useLayoutEffect(() => {
    const shell = shellRef.current
    const changed = previousWidth.current !== width
    previousWidth.current = width
    if (!shell || dragging || !changed) return
    // 读布局会提交样式并创建本次过渡，读到的是过渡起点（被打断时为当前帧宽度）
    const mainWidthDelta = shell.getBoundingClientRect().width - width
    const transitions = shell.getAnimations?.() ?? []
    if (Math.abs(mainWidthDelta) < 1 || transitions.length === 0) return

    let active = true
    const end = (): void => {
      if (!active) return
      active = false
      onSlideChangeRef.current?.(null)
    }
    onSlideChangeRef.current?.(mainWidthDelta)
    void Promise.allSettled(transitions.map(transition => transition.finished)).then(end)
    return end
  }, [shellRef, width, dragging])
}
