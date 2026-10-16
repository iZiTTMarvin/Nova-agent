/**
 * 通用分栏拖拽物理引擎 Hook：
 * 统一左侧 Sidebar 与右侧 InspectorPanel 的 rAF 合帧改宽、4px 手抖死区、
 * 双击恢复默认宽度、Escape 原位回滚、极窄边缘吸附折叠与内嵌 Webview 护盾。
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'

export const SPLIT_PANE_DRAG_DEADZONE_PX = 4
const DOCKING_COLLAPSE_LOWER_BOUND_PX = -80

export interface UseSplitPaneResizeOptions {
  /** 被拖拽改宽的外壳元素 */
  shellRef: RefObject<HTMLElement | null>
  /** 'left' 表示左侧栏（向右拖变宽），'right' 表示右侧栏（向左拖变宽） */
  direction: 'left' | 'right'
  /** 允许的最小宽度 */
  widthMin: number
  /** 允许的最大宽度（数值或动态计算函数） */
  widthMax: number | (() => number)
  /** 双击分割条恢复的默认宽度 */
  defaultWidth: number
  /** 拖到低于该像素阈值时松手自动折叠面板 */
  collapseThresholdPx?: number
  /** 读取当前已提交宽度 */
  getCurrentWidth: () => number
  /** 提交最终宽度到持久化 Store */
  onCommitWidth: (width: number) => void
  /** 触发边缘吸附自动折叠 */
  onCollapse?: () => void
  /** 拖拽会话开始/结束成对通知 */
  onDragSessionChange?: (active: boolean) => void
}

export interface SplitPaneResizeControls {
  dragging: boolean
  onResizeMouseDown: (e: React.MouseEvent) => void
  onResizeDoubleClick: () => void
}

export function useSplitPaneResize({
  shellRef,
  direction,
  widthMin,
  widthMax,
  defaultWidth,
  collapseThresholdPx,
  getCurrentWidth,
  onCommitWidth,
  onCollapse,
  onDragSessionChange
}: UseSplitPaneResizeOptions): SplitPaneResizeControls {
  const [dragging, setDragging] = useState(false)
  const dragStartX = useRef(0)
  const dragStartWidth = useRef(0)
  const latestClientX = useRef(0)
  const hasExceededDeadzone = useRef(false)
  const cancelledRef = useRef(false)
  const rafId = useRef<number | null>(null)
  const dragSessionActive = useRef(false)

  const onDragSessionChangeRef = useRef(onDragSessionChange)
  onDragSessionChangeRef.current = onDragSessionChange
  const onCommitWidthRef = useRef(onCommitWidth)
  onCommitWidthRef.current = onCommitWidth
  const onCollapseRef = useRef(onCollapse)
  onCollapseRef.current = onCollapse
  const getCurrentWidthRef = useRef(getCurrentWidth)
  getCurrentWidthRef.current = getCurrentWidth
  const widthMaxRef = useRef(widthMax)
  widthMaxRef.current = widthMax

  const notifyDragSession = useCallback((active: boolean) => {
    if (active === dragSessionActive.current) return
    dragSessionActive.current = active
    onDragSessionChangeRef.current?.(active)
  }, [])

  const resolveMaxWidth = useCallback((): number => {
    const max = widthMaxRef.current
    return typeof max === 'function' ? max() : max
  }, [])

  const rawWidthFromClientX = useCallback(
    (clientX: number): number => {
      const delta =
        direction === 'left'
          ? clientX - dragStartX.current
          : dragStartX.current - clientX
      return dragStartWidth.current + delta
    },
    [direction]
  )

  const clampWidth = useCallback(
    (rawWidth: number): number => {
      return Math.min(resolveMaxWidth(), Math.max(widthMin, rawWidth))
    },
    [resolveMaxWidth, widthMin]
  )

  const applyShellWidth = useCallback(
    (clientX: number) => {
      const el = shellRef.current
      if (el) el.style.width = `${clampWidth(rawWidthFromClientX(clientX))}px`
    },
    [shellRef, clampWidth, rawWidthFromClientX]
  )

  const clearGlobalDragStyles = useCallback(() => {
    document.documentElement.removeAttribute('data-pane-dragging')
    document.body.style.userSelect = ''
    document.body.style.cursor = ''
  }, [])

  const onResizeMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return
      e.preventDefault()
      dragStartX.current = e.clientX
      latestClientX.current = e.clientX
      dragStartWidth.current = getCurrentWidthRef.current()
      hasExceededDeadzone.current = false
      cancelledRef.current = false
      notifyDragSession(true)
      setDragging(true)
      document.documentElement.setAttribute('data-pane-dragging', 'true')
      document.body.style.userSelect = 'none'
      document.body.style.cursor = 'col-resize'
    },
    [notifyDragSession]
  )

  const onResizeDoubleClick = useCallback(() => {
    const clampedDefault = clampWidth(defaultWidth)
    onCommitWidthRef.current(clampedDefault)
    const el = shellRef.current
    if (el) el.style.width = `${clampedDefault}px`
  }, [clampWidth, defaultWidth, shellRef])

  useEffect(() => {
    if (!dragging) return

    const onMove = (e: MouseEvent) => {
      latestClientX.current = e.clientX
      if (!hasExceededDeadzone.current) {
        if (Math.abs(e.clientX - dragStartX.current) <= SPLIT_PANE_DRAG_DEADZONE_PX) {
          return
        }
        hasExceededDeadzone.current = true
      }
      if (rafId.current === null) {
        rafId.current = requestAnimationFrame(() => {
          rafId.current = null
          applyShellWidth(latestClientX.current)
        })
      }
    }

    const onUp = () => {
      if (cancelledRef.current) return
      if (rafId.current !== null) {
        cancelAnimationFrame(rafId.current)
        rafId.current = null
      }
      if (hasExceededDeadzone.current) {
        const rawWidth = rawWidthFromClientX(latestClientX.current)
        if (
          collapseThresholdPx !== undefined &&
          onCollapseRef.current &&
          rawWidth >= DOCKING_COLLAPSE_LOWER_BOUND_PX &&
          rawWidth < collapseThresholdPx
        ) {
          onCommitWidthRef.current(dragStartWidth.current)
          onCollapseRef.current()
        } else {
          applyShellWidth(latestClientX.current)
          onCommitWidthRef.current(clampWidth(rawWidth))
        }
      }
      notifyDragSession(false)
      setDragging(false)
      clearGlobalDragStyles()
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      cancelledRef.current = true
      if (rafId.current !== null) {
        cancelAnimationFrame(rafId.current)
        rafId.current = null
      }
      const el = shellRef.current
      if (el) el.style.width = `${dragStartWidth.current}px`
      onCommitWidthRef.current(dragStartWidth.current)
      notifyDragSession(false)
      setDragging(false)
      clearGlobalDragStyles()
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      if (rafId.current !== null) {
        cancelAnimationFrame(rafId.current)
        rafId.current = null
      }
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      window.removeEventListener('keydown', onKeyDown, true)
      clearGlobalDragStyles()
      notifyDragSession(false)
    }
  }, [
    dragging,
    applyShellWidth,
    rawWidthFromClientX,
    clampWidth,
    collapseThresholdPx,
    clearGlobalDragStyles,
    notifyDragSession,
    shellRef
  ])

  return {
    dragging,
    onResizeMouseDown,
    onResizeDoubleClick
  }
}
