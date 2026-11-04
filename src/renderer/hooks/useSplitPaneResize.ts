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
  /** 拖拽帧或双击改宽后同步更新附属 DOM（如内层容器宽度），避免等松手才一帧跳变 */
  onLiveWidthChange?: (width: number) => void
  /** 自定义宽度写入；缺省直接写 shell.style.width（实体外壳）。
     阅读区这类「宽度由 CSS 变量驱动」的场景可改写变量，保持单一数据来源。 */
  applyWidth?: (shell: HTMLElement, width: number) => void
  /** clientX 位移 → 宽度增量倍率；内容居中、单侧手柄对称伸缩时传 2。默认 1。 */
  deltaScale?: number
}

export interface SplitPaneResizeControls {
  dragging: boolean
  onResizeMouseDown: (e: React.MouseEvent) => void
  onResizeDoubleClick: () => void
  /** 键盘等非拖拽方式改宽：按边界钳制后直接提交 */
  onResizeToWidth: (width: number) => void
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
  onDragSessionChange,
  onLiveWidthChange,
  applyWidth,
  deltaScale
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
  const onLiveWidthChangeRef = useRef(onLiveWidthChange)
  onLiveWidthChangeRef.current = onLiveWidthChange
  const onCommitWidthRef = useRef(onCommitWidth)
  onCommitWidthRef.current = onCommitWidth
  const onCollapseRef = useRef(onCollapse)
  onCollapseRef.current = onCollapse
  const getCurrentWidthRef = useRef(getCurrentWidth)
  getCurrentWidthRef.current = getCurrentWidth
  const widthMaxRef = useRef(widthMax)
  widthMaxRef.current = widthMax
  const applyWidthRef = useRef(applyWidth)
  applyWidthRef.current = applyWidth
  const deltaScaleRef = useRef(deltaScale ?? 1)
  deltaScaleRef.current = deltaScale ?? 1

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
      return dragStartWidth.current + delta * deltaScaleRef.current
    },
    [direction]
  )

  const clampWidth = useCallback(
    (rawWidth: number): number => {
      return Math.min(resolveMaxWidth(), Math.max(widthMin, rawWidth))
    },
    [resolveMaxWidth, widthMin]
  )

  /** 统一的实际宽度写入点：默认改外壳 style.width，外部可注入 applyWidth 改写别的目标。 */
  const writeShellWidth = useCallback((el: HTMLElement, width: number) => {
    const custom = applyWidthRef.current
    if (custom) custom(el, width)
    else el.style.width = `${width}px`
  }, [])

  const applyShellWidth = useCallback(
    (clientX: number) => {
      const nextWidth = clampWidth(rawWidthFromClientX(clientX))
      const el = shellRef.current
      if (el) writeShellWidth(el, nextWidth)
      onLiveWidthChangeRef.current?.(nextWidth)
    },
    [shellRef, clampWidth, rawWidthFromClientX, writeShellWidth]
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

  const onResizeToWidth = useCallback((width: number) => {
    const clamped = clampWidth(width)
    onCommitWidthRef.current(clamped)
    const el = shellRef.current
    if (el) writeShellWidth(el, clamped)
    onLiveWidthChangeRef.current?.(clamped)
  }, [clampWidth, shellRef, writeShellWidth])

  const onResizeDoubleClick = useCallback(() => {
    onResizeToWidth(defaultWidth)
  }, [defaultWidth, onResizeToWidth])

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
          onLiveWidthChangeRef.current?.(dragStartWidth.current)
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
      if (el) writeShellWidth(el, dragStartWidth.current)
      onLiveWidthChangeRef.current?.(dragStartWidth.current)
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
    onResizeDoubleClick,
    onResizeToWidth
  }
}
