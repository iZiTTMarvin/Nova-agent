import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { ChatPanel, type ChatPanelHandle } from '../chat/ChatPanel'
import { InspectorPanel } from '../inspector/InspectorPanel'
import { LearningSurface } from '../learning/LearningSurface'
import {
  BROWSER_SPLIT_MIN_PX,
  useLayoutStore
} from '../../stores/useLayoutStore'
import { useWorkspaceStore } from '../../stores/useWorkspaceStore'
import { BrowserPanel } from './BrowserPanel'

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
