import { lazy, Suspense, type ReactNode, type RefObject } from 'react'
import { ChatPanel, type ChatPanelHandle } from '../chat/ChatPanel'
import { InspectorPanel } from '../inspector/InspectorPanel'
import { GlassSessionHeader } from '../../components/ContentTopBar'
import { useWorkspaceStore } from '../../stores/useWorkspaceStore'

// 学习表面是另一套完整交互面，开发会话首屏用不到：按需加载，不进首屏包。
const LearningSurface = lazy(() =>
  import('../learning/LearningSurface').then(m => ({ default: m.LearningSurface }))
)

/**
 * 主区表面切换器：决定显示聊天还是学习表面；右侧面板（审阅/文件/浏览器）常驻。
 * 浏览器作为右侧面板的页签之一，不再挤占主区。
 * 玻璃面内部横向：「会话头 + 主区」列 | inspector 列；inspector 通顶通底，
 * 分隔线因此贯穿整个玻璃面，会话头只覆盖主区。
 */
export function BrowserWorkspaceBody(props: {
  chatPanelRef: RefObject<ChatPanelHandle | null>
}): ReactNode {
  const { chatPanelRef } = props
  const currentSessionId = useWorkspaceStore((state) => state.currentSessionId)
  const currentMode = useWorkspaceStore((state) => state.currentMode)

  // learn 会话走独立学习表面；会话焦点仍由主进程 Workspace Owner 决定
  const isLearnSurface = currentMode === 'learn' && currentSessionId !== null

  return (
    <div className="app-workspace__body">
      <div className="app-workspace__main">
        <GlassSessionHeader />
        <div className="app-workspace__stage">
          {isLearnSurface && currentSessionId ? (
            <Suspense fallback={null}>
              <LearningSurface sessionId={currentSessionId} />
            </Suspense>
          ) : (
            <ChatPanel ref={chatPanelRef} />
          )}
        </div>
      </div>
      <InspectorPanel
        onDragSessionChange={(active) => {
          if (active) chatPanelRef.current?.freezeReadingWidth()
          else chatPanelRef.current?.restoreReadingWidth()
        }}
        onSlideChange={(mainWidthDelta) => {
          if (mainWidthDelta === null) chatPanelRef.current?.restoreReadingWidth()
          else chatPanelRef.current?.freezeReadingWidth(mainWidthDelta)
        }}
      />
    </div>
  )
}
