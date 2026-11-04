/**
 * Inspector 宽度拖拽：复用通用分栏手势引擎 useSplitPaneResize，
 * 并维护窗口缩放时的可用最大宽度钳制；可用宽度连最小面板都放不下时请求收起。
 */
import { useCallback, useEffect, useState, type KeyboardEvent, type RefObject } from 'react'
import {
  useLayoutStore,
  INSPECTOR_WIDTH_MAX,
  INSPECTOR_WIDTH_DEFAULT,
  INSPECTOR_COLLAPSE_THRESHOLD_PX
} from '../../stores/useLayoutStore'
import { useSplitPaneResize } from '../../hooks/useSplitPaneResize'

/** 面板不能挤掉输入区的最小可用宽度；更窄时应先压缩面板。 */
const CHAT_PANEL_MIN_WIDTH = 248

/** 键盘步进；Shift 为大步 */
const KEY_STEP_PX = 16
const KEY_STEP_LARGE_PX = 64

export interface UseInspectorResizeOptions {
  /** 被拖拽改宽的外壳元素 */
  shellRef: RefObject<HTMLElement | null>
  /** 当前页签允许的最小宽度 */
  widthMin: number
  /** 面板当前是否打开；只有打开时才会因宽度不足而收起 */
  open?: boolean
  /** 拖拽越过边缘折叠阈值，或可用宽度放不下最小面板时收起面板 */
  onCollapse?: () => void
  /** 拖拽会话开始/结束成对通知；重复清理不会重复触发 */
  onDragSessionChange?: (active: boolean) => void
  /** 拖拽帧或双击改宽后同步更新内层容器宽度，让面板内文字在拖拽中实时跟随 */
  onLiveWidthChange?: (width: number) => void
}

export function useInspectorResize({
  shellRef,
  widthMin,
  open = false,
  onCollapse,
  onDragSessionChange,
  onLiveWidthChange
}: UseInspectorResizeOptions) {
  const setInspectorWidth = useLayoutStore(s => s.setInspectorWidth)
  // 只用于分隔条的 aria-valuemax，宽度本身仍以 useLayoutStore 为准
  const [availableMax, setAvailableMax] = useState(INSPECTOR_WIDTH_MAX)

  const readAvailableWidth = useCallback(
    () => shellRef.current?.parentElement?.getBoundingClientRect().width ?? 0,
    [shellRef]
  )

  const getAvailableInspectorMaxWidth = useCallback(() => {
    const availableWidth = readAvailableWidth()
    if (availableWidth <= 0) return INSPECTOR_WIDTH_MAX
    return Math.min(
      INSPECTOR_WIDTH_MAX,
      Math.max(widthMin, availableWidth - CHAT_PANEL_MIN_WIDTH)
    )
  }, [readAvailableWidth, widthMin])

  const { dragging, onResizeMouseDown, onResizeDoubleClick, onResizeToWidth } = useSplitPaneResize({
    shellRef,
    direction: 'right',
    widthMin,
    widthMax: getAvailableInspectorMaxWidth,
    defaultWidth: INSPECTOR_WIDTH_DEFAULT,
    collapseThresholdPx: INSPECTOR_COLLAPSE_THRESHOLD_PX,
    getCurrentWidth: () => Math.max(widthMin, useLayoutStore.getState().inspectorWidth),
    onCommitWidth: setInspectorWidth,
    onCollapse,
    onDragSessionChange,
    onLiveWidthChange
  })

  const clampToAvailableWidth = useCallback(() => {
    if (dragging) return
    const availableWidth = readAvailableWidth()
    // 放不下「聊天最小宽 + 面板最小宽」时收起，而不是让 CSS 把面板压到最小宽以下
    if (open && availableWidth > 0 && availableWidth < CHAT_PANEL_MIN_WIDTH + widthMin) {
      onCollapse?.()
      return
    }
    const maxWidth = getAvailableInspectorMaxWidth()
    setAvailableMax(maxWidth)
    const currentWidth = useLayoutStore.getState().inspectorWidth
    const nextWidth = Math.min(maxWidth, currentWidth)
    if (nextWidth === currentWidth) return
    setInspectorWidth(nextWidth)
    const el = shellRef.current
    if (el && el.style.width !== '0px') el.style.width = `${nextWidth}px`
    onLiveWidthChange?.(nextWidth)
  }, [
    dragging,
    getAvailableInspectorMaxWidth,
    onCollapse,
    onLiveWidthChange,
    open,
    readAvailableWidth,
    setInspectorWidth,
    shellRef,
    widthMin
  ])

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

  // 分隔条在面板左缘：← 外移变宽、→ 内收变窄，Home/End 到最小/最大，Enter 恢复默认
  const onResizeKeyDown = useCallback((e: KeyboardEvent<HTMLElement>) => {
    const current = Math.max(widthMin, useLayoutStore.getState().inspectorWidth)
    const step = e.shiftKey ? KEY_STEP_LARGE_PX : KEY_STEP_PX
    const next =
      e.key === 'ArrowLeft' ? current + step
        : e.key === 'ArrowRight' ? current - step
          : e.key === 'Home' ? widthMin
            : e.key === 'End' ? getAvailableInspectorMaxWidth()
              : e.key === 'Enter' ? INSPECTOR_WIDTH_DEFAULT
                : null
    if (next === null) return
    e.preventDefault()
    onResizeToWidth(next)
  }, [getAvailableInspectorMaxWidth, onResizeToWidth, widthMin])

  return {
    dragging,
    onResizeMouseDown,
    onResizeDoubleClick,
    onResizeKeyDown,
    widthMax: Math.max(widthMin, availableMax)
  }
}
