/**
 * 右侧 Inspector 面板，宽度可拖拽，开合带宽度过渡。顶栏是标签条：每个已打开的视图一个标签
 * （开发会话：审阅 / 文件 / 浏览；学习会话：大纲 / 文件 / 浏览），没有标签时显示启动器。
 * 浏览器标签承载内置浏览器（用户页与 AI 页）。
 */
import React, { useEffect, useRef } from 'react'
import {
  useLayoutStore,
  INSPECTOR_WIDTH_MIN,
  BROWSER_PANE_WIDTH_MIN,
  type InspectorViewKey
} from '../../stores/useLayoutStore'
import { ReviewTab } from './ReviewTab'
import { FilesTab } from './FilesTab'
import { PlanInspectorView } from './PlanInspectorView'
import { LearningOutlinePane } from '../learning/outline/LearningOutlinePane'
import { BrowserPanel } from '../browser/BrowserPanel'
import { InspectorLauncher, InspectorOpenMenu } from './InspectorLauncher'
import { InspectorResizeHandle } from './InspectorResizeHandle'
import { InspectorTabStrip } from './InspectorTabStrip'
import { InspectorToggleButton } from './InspectorToggleButton'
import { VIEW_META } from './inspectorViewMeta'
import { useInspectorResize } from './useInspectorResize'
import { useInspectorTabs } from './useInspectorTabs'
import { usePanelPresence } from './usePanelPresence'
import { useWorkspaceStore } from '../../stores/useWorkspaceStore'
import './InspectorPanel.css'

/**
 * 开合用宽度过渡：内层固定宽度并靠右，外壳只做裁剪，所以动画期间面板内容不重排，
 * 只有相邻聊天区随宽度变化。
 * 拖拽期间：宽度只写 DOM（ref），过渡关闭、不触发 store / localStorage，松手一次性提交。
 */
const SLIDE_TRANSITION = 'width var(--transition-normal), opacity var(--transition-normal)'

export interface InspectorPanelProps {
  /** 拖拽会话开始/结束成对通知；连接方负责冻结/恢复相邻布局，Inspector 自身不持有外部状态 */
  onDragSessionChange?: (active: boolean) => void
}

export const InspectorPanel: React.FC<InspectorPanelProps> = ({ onDragSessionChange }) => {
  const learnSessionId = useWorkspaceStore(s => s.currentMode === 'learn' ? s.currentSessionId : null)
  const isLearn = learnSessionId !== null
  const devOpen = useLayoutStore(s => s.inspectorOpen)
  const learnOpen = useLayoutStore(s => s.learnInspectorOpen)
  const inspectorOpen = isLearn ? learnOpen : devOpen
  const closeLearnInspector = useLayoutStore(s => s.closeLearnInspector)
  const inspectorWidth = useLayoutStore(s => s.inspectorWidth)
  const inspectorSurface = useLayoutStore(s => s.inspectorSurface)
  const closeDevInspector = useLayoutStore(s => s.closeInspector)
  const closeInspector = isLearn ? closeLearnInspector : closeDevInspector
  const { tabs, activeTab, activate, close } = useInspectorTabs(isLearn)

  /** 拖拽期间宽度直写面板 DOM，避免每次 mousemove 触发 store 重渲染 */
  const asideRef = useRef<HTMLElement>(null)

  // 浏览器标签需要更宽的舞台；其余标签维持原有边界
  const widthMin = activeTab === 'browser' ? BROWSER_PANE_WIDTH_MIN : INSPECTOR_WIDTH_MIN
  const { dragging, onResizeMouseDown } = useInspectorResize({
    shellRef: asideRef,
    widthMin,
    onDragSessionChange
  })
  const showContent = usePanelPresence({ open: inspectorOpen, shellRef: asideRef })

  useEffect(() => {
    if (!inspectorOpen) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // 菜单/弹层先消费 Escape；捕获阶段会绕过它们的关闭与焦点恢复。
      if (e.defaultPrevented) return
      // 输入类控件内的 Esc 属于编辑取消（重命名、问答面板等），不抢占
      const target = e.target as HTMLElement | null
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return
      }
      e.preventDefault()
      closeInspector()

      // 面板内的按钮会随收起过渡卸载，焦点交给收起后仍可见的顶栏开关。
      requestAnimationFrame(() => {
        const label = isLearn ? '大纲、文件与浏览面板' : '审阅、文件与浏览面板'
        const toggle = Array.from(
          document.querySelectorAll<HTMLButtonElement>(`button[aria-label="${label}"]`)
        ).find(button => !asideRef.current?.contains(button) && !button.closest('[aria-hidden="true"]'))
        toggle?.focus()
      })
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [inspectorOpen, closeInspector, isLearn])

  // 浏览器标签激活时渲染宽度不低于舞台下限；不回写 store，切回其它标签恢复原宽
  const effectiveWidth = activeTab === 'browser'
    ? Math.max(inspectorWidth, BROWSER_PANE_WIDTH_MIN)
    : inspectorWidth
  const width = inspectorOpen ? effectiveWidth : 0

  const renderPane = (key: InspectorViewKey): React.ReactNode => {
    switch (key) {
      case 'review':
        return <ReviewTab />
      case 'files':
        return <FilesTab />
      case 'browser':
        return <BrowserPanel />
      case 'outline':
        return learnSessionId ? <LearningOutlinePane sessionId={learnSessionId} /> : null
    }
  }

  return (
    <aside
      ref={asideRef}
      className={`inspector-panel${inspectorOpen ? ' inspector-panel--open' : ''}${dragging ? ' inspector-panel--dragging' : ''}`}
      style={{
        width,
        transition: dragging ? 'none' : SLIDE_TRANSITION,
        opacity: inspectorOpen ? 1 : 0
      }}
      aria-hidden={!inspectorOpen}
    >
      {showContent && (
        <>
          <InspectorResizeHandle onMouseDown={onResizeMouseDown} active={dragging} />
          <div
            className="inspector-panel__inner"
            style={{ width: effectiveWidth }}
          >
            {!isLearn && inspectorSurface === 'plan' ? (
              <PlanInspectorView />
            ) : (
              <>
                <header className="inspector-panel__header">
                  <InspectorTabStrip tabs={tabs} activeTab={activeTab} onActivate={activate} onClose={close} />
                  <div className="inspector-panel__actions">
                    <InspectorOpenMenu />
                    <InspectorToggleButton className="inspector-icon-btn inspector-icon-btn--active" />
                  </div>
                </header>
                {tabs.length === 0 ? (
                  <div className="inspector-panel__home">
                    <InspectorLauncher />
                  </div>
                ) : (
                  <div className="inspector-panel__body">
                    {tabs.map(key => (
                      <div
                        key={key}
                        className={`inspector-panel__pane${key === 'browser' ? ' inspector-panel__pane--browser' : ''}`}
                        hidden={key !== activeTab}
                        role="tabpanel"
                        aria-label={VIEW_META[key].name}
                      >
                        {renderPane(key)}
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        </>
      )}
    </aside>
  )
}
