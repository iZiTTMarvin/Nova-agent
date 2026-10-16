/**
 * Inspector 宽度拖拽：复用通用分栏手势引擎 useSplitPaneResize，
 * 并维护窗口缩放时的可用最大宽度钳制。
 */
import { useCallback, useEffect, type RefObject } from 'react'
import {
  useLayoutStore,
  INSPECTOR_WIDTH_MAX,
  INSPECTOR_WIDTH_DEFAULT,
  INSPECTOR_COLLAPSE_THRESHOLD_PX
} from '../../stores/useLayoutStore'
import { useSplitPaneResize } from '../../hooks/useSplitPaneResize'

/** 面板不能挤掉输入区的最小可用宽度；更窄时应先压缩面板。 */
const CHAT_PANEL_MIN_WIDTH = 248

export interface UseInspectorResizeOptions {
  /** 被拖拽改宽的外壳元素 */
  shellRef: RefObject<HTMLElement | null>
  /** 当前页签允许的最小宽度 */
  widthMin: number
  /** 拖拽越过边缘折叠阈值时收起面板 */
  onCollapse?: () => void
  /** 拖拽会话开始/结束成对通知；重复清理不会重复触发 */
  onDragSessionChange?: (active: boolean) => void
}

export function useInspectorResize({
  shellRef,
  widthMin,
  onCollapse,
  onDragSessionChange
}: UseInspectorResizeOptions) {
  const setInspectorWidth = useLayoutStore(s => s.setInspectorWidth)

  const getAvailableInspectorMaxWidth = useCallback(() => {
    const availableWidth = shellRef.current?.parentElement?.getBoundingClientRect().width ?? 0
    if (availableWidth <= 0) return INSPECTOR_WIDTH_MAX
    return Math.min(
      INSPECTOR_WIDTH_MAX,
      Math.max(widthMin, availableWidth - CHAT_PANEL_MIN_WIDTH)
    )
  }, [shellRef, widthMin])

  const { dragging, onResizeMouseDown, onResizeDoubleClick } = useSplitPaneResize({
    shellRef,
    direction: 'right',
    widthMin,
    widthMax: getAvailableInspectorMaxWidth,
    defaultWidth: INSPECTOR_WIDTH_DEFAULT,
    collapseThresholdPx: INSPECTOR_COLLAPSE_THRESHOLD_PX,
    getCurrentWidth: () => useLayoutStore.getState().inspectorWidth,
    onCommitWidth: setInspectorWidth,
    onCollapse,
    onDragSessionChange
  })

  const clampToAvailableWidth = useCallback(() => {
    if (dragging) return
    const currentWidth = useLayoutStore.getState().inspectorWidth
    const nextWidth = Math.min(getAvailableInspectorMaxWidth(), currentWidth)
    if (nextWidth === currentWidth) return
    setInspectorWidth(nextWidth)
    const el = shellRef.current
    if (el && el.style.width !== '0px') el.style.width = `${nextWidth}px`
  }, [dragging, getAvailableInspectorMaxWidth, setInspectorWidth, shellRef])

  useEffect(() => {
    clampToAvailableWidth()
    window.addEventListener('resize', clampToAvailableWidth)
    const parent = shellRef.current?.parentElement
    const observer =
      typeof ResizeObserver === 'undefined' || !parent
        ? null
        : new ResizeObserver(clampToAvailableWidth)
    if (observer && parent) observer.observe(parent)
    return () => {
      window.removeEventListener('resize', clampToAvailableWidth)
      observer?.disconnect()
    }
  }, [clampToAvailableWidth, shellRef])

  return { dragging, onResizeMouseDown, onResizeDoubleClick }
}
