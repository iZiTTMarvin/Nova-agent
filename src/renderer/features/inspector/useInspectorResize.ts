/**
 * Inspector 宽度拖拽：唯一拥有拖拽会话（起止通知、rAF 合帧、body 光标）的 hook。
 * 拖拽期间宽度只写外壳 DOM，不触发 store / localStorage / 重渲染；松手一次性提交。
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import {
  useLayoutStore,
  INSPECTOR_WIDTH_MAX
} from '../../stores/useLayoutStore'

export interface UseInspectorResizeOptions {
  /** 被拖拽改宽的外壳元素 */
  shellRef: RefObject<HTMLElement | null>
  /** 当前页签允许的最小宽度 */
  widthMin: number
  /** 拖拽会话开始/结束成对通知；重复清理不会重复触发 */
  onDragSessionChange?: (active: boolean) => void
}

export function useInspectorResize({ shellRef, widthMin, onDragSessionChange }: UseInspectorResizeOptions) {
  const setInspectorWidth = useLayoutStore(s => s.setInspectorWidth)
  const [dragging, setDragging] = useState(false)
  const dragStartX = useRef(0)
  const dragStartWidth = useRef(0)
  const latestClientX = useRef(0)
  const rafId = useRef<number | null>(null)
  const dragSessionActive = useRef(false)
  const onDragSessionChangeRef = useRef(onDragSessionChange)
  onDragSessionChangeRef.current = onDragSessionChange

  const notifyDragSession = useCallback((active: boolean) => {
    if (active === dragSessionActive.current) return
    dragSessionActive.current = active
    onDragSessionChangeRef.current?.(active)
  }, [])

  const widthFromClientX = useCallback((clientX: number) => {
    const delta = dragStartX.current - clientX
    return Math.min(INSPECTOR_WIDTH_MAX, Math.max(widthMin, dragStartWidth.current + delta))
  }, [widthMin])

  const applyShellWidth = useCallback((clientX: number) => {
    const el = shellRef.current
    if (el) el.style.width = `${widthFromClientX(clientX)}px`
  }, [shellRef, widthFromClientX])

  const onResizeMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      dragStartX.current = e.clientX
      latestClientX.current = e.clientX
      dragStartWidth.current = useLayoutStore.getState().inspectorWidth
      notifyDragSession(true)
      setDragging(true)
      document.body.style.userSelect = 'none'
      document.body.style.cursor = 'col-resize'
    },
    [notifyDragSession]
  )

  useEffect(() => {
    if (!dragging) return

    // 高频 mousemove 只保存最新 clientX，每帧最多写一次外壳宽度
    const onMove = (e: MouseEvent) => {
      latestClientX.current = e.clientX
      if (rafId.current === null) {
        rafId.current = requestAnimationFrame(() => {
          rafId.current = null
          applyShellWidth(latestClientX.current)
        })
      }
    }
    const onUp = () => {
      // 先消费最后指针位置（含未执行的帧），再提交宽度和结束冻结
      if (rafId.current !== null) {
        cancelAnimationFrame(rafId.current)
        rafId.current = null
      }
      applyShellWidth(latestClientX.current)
      setInspectorWidth(widthFromClientX(latestClientX.current))
      notifyDragSession(false)
      setDragging(false)
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      if (rafId.current !== null) {
        cancelAnimationFrame(rafId.current)
        rafId.current = null
      }
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
      // 卸载/中断路径同样结束拖拽会话，恢复相邻布局
      notifyDragSession(false)
    }
  }, [dragging, applyShellWidth, widthFromClientX, setInspectorWidth, notifyDragSession])

  return { dragging, onResizeMouseDown }
}
