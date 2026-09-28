import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { ChatPanel, type ChatPanelHandle } from '../chat/ChatPanel'
import { BrowserPanel } from './BrowserPanel'
import { InspectorPanel } from '../inspector/InspectorPanel'
import { LearningSurface } from '../learning/LearningSurface'
import {
  BROWSER_SPLIT_MIN_PX,
  useLayoutStore
} from '../../stores/useLayoutStore'
import { useWorkspaceStore } from '../../stores/useWorkspaceStore'

/**
 * 本组件是「表面切换器」：决定主区显示聊天还是学习表面、是否并排显示浏览器、
 * 以及审阅面板的位置。三个表面都保持静态 import。
 *
 * 曾尝试把 BrowserPanel / InspectorPanel 改为 lazy 以移出首屏，实测两处都不可行：
 * - BrowserPanel 与 BrowserGuestLayer 存在隐式布局握手：guest 层用自己的盒子给
 *   <webview> 定尺寸，依赖 BrowserPanel 先渲染出舞台元素；而
 *   BrowserGuestLayer.tsx:95 的定尺寸 effect 依赖项里没有「面板已就绪」信号，
 *   面板晚挂载后 effect 不重跑，webview 永久 0×0（29 个浏览器 E2E 用例失败）。
 * - InspectorPanel 原本**始终挂载**（关闭时是宽度为 0 但仍在 DOM 里），
 *   本组件的 measure() 用 querySelector('.inspector-panel') 的 offsetWidth 参与
 *   split 判定；不渲染它会改变并排/全屏判定，进而改变浏览器舞台可用区域
 *   （browser-fault-gate 的 BROWSER_OPEN 随之 not_applied）。
 * 要让这两处懒加载成立，都得给既有契约补「就绪」信号，属于为性能扩张契约，不做。
 */

export function BrowserWorkspaceBody(props: {
  chatPanelRef: RefObject<ChatPanelHandle | null>
}): ReactNode {
  const { chatPanelRef } = props
  const bodyRef = useRef<HTMLDivElement>(null)
  const browserOpen = useLayoutStore((state) => state.browserSurfaceOpen)
  const inspectorOpen = useLayoutStore((state) => state.inspectorOpen)
  const inspectorWidth = useLayoutStore((state) => state.inspectorWidth)
  const currentSessionId = useWorkspaceStore((state) => state.currentSessionId)
  const currentMode = useWorkspaceStore((state) => state.currentMode)
  const [split, setSplit] = useState(false)

  // learn 会话走独立学习表面；会话焦点仍由主进程 Workspace Owner 决定
  const isLearnSurface = currentMode === 'learn' && currentSessionId !== null

  useEffect(() => {
    const el = bodyRef.current
    if (!el) return
    const measure = (): void => {
      const inspector = el.querySelector<HTMLElement>('.inspector-panel')
      const inspectorW = inspector && inspector.offsetWidth > 0 ? inspector.offsetWidth : 0
      setSplit(el.clientWidth - inspectorW >= BROWSER_SPLIT_MIN_PX)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    const inspector = el.querySelector('.inspector-panel')
    if (inspector) ro.observe(inspector)
    return () => ro.disconnect()
  }, [inspectorOpen, inspectorWidth, browserOpen])

  const expanded = browserOpen && !split

  return (
    <div className="app-workspace__body" ref={bodyRef}>
      <div
        className="app-workspace__main"
        hidden={expanded}
        aria-hidden={expanded}
        data-browser-expanded={expanded ? 'true' : 'false'}
      >
        {isLearnSurface && currentSessionId ? (
          <LearningSurface sessionId={currentSessionId} />
        ) : (
          <ChatPanel ref={chatPanelRef} />
        )}
      </div>
      {browserOpen && <BrowserPanel mode={expanded ? 'expanded' : 'split'} />}
      <InspectorPanel
        onDragSessionChange={(active) => {
          if (active) chatPanelRef.current?.freezeReadingWidth()
          else chatPanelRef.current?.restoreReadingWidth()
        }}
      />
    </div>
  )
}
