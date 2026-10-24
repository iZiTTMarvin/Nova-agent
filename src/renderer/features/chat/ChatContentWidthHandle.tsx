/**
 * 阅读区宽度手柄：挂在 .chat-panel 左缘的隐形拖拽热区（开发/学习两个表面共用）。
 * 拖拽改写外壳上的 --chat-content-max-width —— 阅读柱、composer 与状态面板让位公式
 * 都吃这个变量，一处写入全链路同步；偏好经 useLayoutStore 持久化，两个表面共享一份。
 * 复用分栏手势引擎：向左拖变宽、deltaScale=2 让柱体绕中心对称伸缩，手柄始终贴着指针。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, type ReactNode, type WheelEvent } from 'react'
import { CHAT_CONTENT_WIDTH_MIN, useLayoutStore } from '../../stores/useLayoutStore'
import { useSplitPaneResize } from '../../hooks/useSplitPaneResize'

/** 两侧必须为柱宽预留的横向预算：取左侧最小余量（24 间距 + 10 热区 + 24 安全区）的两倍。
   拖到上限时柱缘离面板边恰剩 58px，热区不会消失、始终可往回拖；右侧对称留白同时覆盖滚动条。 */
const EDGE_BUDGET_PX = 58 * 2

/** 按容器实时宽度解析显示宽度：偏好只作意图，永远钳到 [MIN, 容器剩余]。 */
function resolveContentWidth(panelWidth: number, preference: number | null): number {
  const max = Math.max(CHAT_CONTENT_WIDTH_MIN, panelWidth - EDGE_BUDGET_PX)
  return Math.min(Math.max(preference ?? CHAT_CONTENT_WIDTH_MIN, CHAT_CONTENT_WIDTH_MIN), max)
}

export function ChatContentWidthHandle(): ReactNode {
  const handleRef = useRef<HTMLDivElement>(null)
  // 外壳 = .chat-panel（本组件是其直接子元素），mount 后回填
  const shellRef = useRef<HTMLElement | null>(null)

  /** 把解析后的宽度写进外壳变量；无偏好时还原到样式表默认值。 */
  const publish = useCallback(() => {
    const panel = shellRef.current
    if (!panel) return
    const preference = useLayoutStore.getState().chatContentWidth
    if (preference === null) {
      panel.style.removeProperty('--chat-content-max-width')
      return
    }
    panel.style.setProperty('--chat-content-max-width', `${Math.round(resolveContentWidth(panel.offsetWidth, preference))}px`)
  }, [])

  const { dragging, onResizeMouseDown, onResizeDoubleClick } = useSplitPaneResize({
    shellRef,
    direction: 'right', // 手柄在左缘：指针左移 = 变宽
    widthMin: CHAT_CONTENT_WIDTH_MIN,
    widthMax: () =>
      Math.max(CHAT_CONTENT_WIDTH_MIN, (shellRef.current?.offsetWidth ?? CHAT_CONTENT_WIDTH_MIN) - EDGE_BUDGET_PX),
    defaultWidth: CHAT_CONTENT_WIDTH_MIN,
    getCurrentWidth: () =>
      resolveContentWidth(
        shellRef.current?.offsetWidth ?? CHAT_CONTENT_WIDTH_MIN,
        useLayoutStore.getState().chatContentWidth
      ),
    onCommitWidth: (w) => useLayoutStore.getState().setChatContentWidth(w),
    applyWidth: (el, w) => el.style.setProperty('--chat-content-max-width', `${Math.round(w)}px`),
    deltaScale: 2
  })

  // 容器宽度变化（侧栏拖拽、面板开合、窗口缩放）时重新钳制已发布的变量值；
  // 拖拽本手柄期间跳过，避免外部动画与拖拽写入互相覆盖
  const draggingRef = useRef(dragging)
  draggingRef.current = dragging
  // layout effect：已有宽偏好时首帧就按偏好排，避免先画默认宽再跳变
  useLayoutEffect(() => {
    const panel = handleRef.current?.parentElement ?? null
    shellRef.current = panel
    if (!panel) return
    publish()
    const observer = new ResizeObserver(() => {
      if (!draggingRef.current) publish()
    })
    observer.observe(panel)
    return () => observer.disconnect()
  }, [publish])

  // 热区压在滚动容器上方但不是其子节点：滚轮停在条上时转发给消息流，不留滚动死角
  const onWheel = useCallback((e: WheelEvent<HTMLDivElement>) => {
    if (e.deltaY === 0) return
    shellRef.current
      ?.querySelector<HTMLElement>(':scope > .chat-messages')
      ?.scrollBy({ top: e.deltaY })
  }, [])

  // 玻璃把手只认一个 CSS 变量：mousemove 直接写 --chat-handle-y，不进 React 渲染管线
  const trackHandleY = useCallback((clientY: number) => {
    const el = handleRef.current
    if (!el) return
    el.style.setProperty('--chat-handle-y', `${clientY - el.getBoundingClientRect().top}px`)
  }, [])

  // 拖拽中指针会划出热区，窗口级监听让把手全程跟手
  useEffect(() => {
    if (!dragging) return
    const onMove = (e: MouseEvent) => trackHandleY(e.clientY)
    window.addEventListener('mousemove', onMove)
    return () => window.removeEventListener('mousemove', onMove)
  }, [dragging, trackHandleY])

  return (
    <div
      ref={handleRef}
      className={`chat-width-handle${dragging ? ' chat-width-handle--active' : ''}`}
      onMouseDown={onResizeMouseDown}
      onDoubleClick={onResizeDoubleClick}
      onMouseMove={(e) => trackHandleY(e.clientY)}
      onWheel={onWheel}
    />
  )
}
