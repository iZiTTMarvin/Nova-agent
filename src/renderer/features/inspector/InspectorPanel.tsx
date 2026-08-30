/**
 * 右侧 Inspector 面板：审阅 / 文件 Tab，宽度可拖拽。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { CloseIcon } from '../../components/Icons'
import { useLayoutStore, INSPECTOR_WIDTH_MIN, INSPECTOR_WIDTH_MAX } from '../../stores/useLayoutStore'
import type { InspectorTab as InspectorTabId } from '../../stores/useLayoutStore'
import { ReviewTab } from './ReviewTab'
import { FilesTab } from './FilesTab'
import { PlanInspectorView } from './PlanInspectorView'
import './InspectorPanel.css'

/**
 * 展开/收起统一用 transform 合成器动画（width 是布局属性，会触发每帧主线程 layout+paint）。
 * 宽度在开合瞬间一次性切换（布局只重排一次），动画帧走 GPU、不触发布局。
 * 拖拽期间：宽度只写 DOM（ref），过渡关闭、不触发 store / localStorage，松手一次性提交。
 */
const SLIDE_TRANSITION = 'transform var(--transition-normal), opacity var(--transition-normal)'

export interface InspectorPanelProps {
  /** 拖拽会话开始/结束成对通知；连接方负责冻结/恢复相邻布局，Inspector 自身不持有外部状态 */
  onDragSessionChange?: (active: boolean) => void
}

export const InspectorPanel: React.FC<InspectorPanelProps> = ({ onDragSessionChange }) => {
  const inspectorOpen = useLayoutStore(s => s.inspectorOpen)
  const inspectorTab = useLayoutStore(s => s.inspectorTab)
  const inspectorWidth = useLayoutStore(s => s.inspectorWidth)
  const inspectorSurface = useLayoutStore(s => s.inspectorSurface)
  const setInspectorTab = useLayoutStore(s => s.setInspectorTab)
  const closeInspector = useLayoutStore(s => s.closeInspector)
  const setInspectorWidth = useLayoutStore(s => s.setInspectorWidth)

  const [mounted, setMounted] = useState(false)
  const [visitedReview, setVisitedReview] = useState(false)
  const [visitedFiles, setVisitedFiles] = useState(false)
  const [dragging, setDragging] = useState(false)
  const dragStartX = useRef(0)
  const dragStartWidth = useRef(0)
  const latestClientX = useRef(0)
  const rafId = useRef<number | null>(null)
  /** 拖拽期间宽度直写面板 DOM，避免每次 mousemove 触发 store 重渲染 */
  const asideRef = useRef<HTMLElement>(null)
  /** 拖拽会话通知去重：保证开始/结束严格成对，重复清理无副作用 */
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
    return Math.min(INSPECTOR_WIDTH_MAX, Math.max(INSPECTOR_WIDTH_MIN, dragStartWidth.current + delta))
  }, [])

  /** 拖拽期间直接写外壳 DOM 宽度：过渡已关闭，不触发 store / localStorage / 重渲染 */
  const applyShellWidth = useCallback((clientX: number) => {
    const el = asideRef.current
    if (el) el.style.width = `${widthFromClientX(clientX)}px`
  }, [widthFromClientX])

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

  useEffect(() => {
    if (inspectorOpen) setMounted(true)
  }, [inspectorOpen])

  useEffect(() => {
    if (!inspectorOpen) return
    if (inspectorTab === 'review') setVisitedReview(true)
    if (inspectorTab === 'files') setVisitedFiles(true)
  }, [inspectorOpen, inspectorTab])

  useEffect(() => {
    if (!inspectorOpen) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
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
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [inspectorOpen, closeInspector])

  const width = inspectorOpen ? inspectorWidth : 0
  const showContent = mounted && inspectorOpen

  const switchTab = (tab: InspectorTabId) => {
    setInspectorTab(tab)
  }

  return (
    <aside
      ref={asideRef}
      className={`inspector-panel${inspectorOpen ? ' inspector-panel--open' : ''}${dragging ? ' inspector-panel--dragging' : ''}`}
      style={{
        width,
        transform: inspectorOpen ? 'translateX(0)' : 'translateX(100%)',
        transition: dragging ? 'none' : SLIDE_TRANSITION,
        opacity: inspectorOpen ? 1 : 0
      }}
      aria-hidden={!inspectorOpen}
    >
      {showContent && (
        <>
          <div
            className="inspector-panel__resize"
            onMouseDown={onResizeMouseDown}
            role="separator"
            aria-orientation="vertical"
            aria-label="调整面板宽度"
          />
          <div
            className="inspector-panel__inner"
            style={{ width: inspectorWidth }}
          >
            {inspectorSurface === 'plan' ? (
              <PlanInspectorView />
            ) : (
              <>
                <header className="inspector-panel__header">
                  <div className="inspector-panel__tabs" role="tablist">
                    <button
                      type="button"
                      role="tab"
                      aria-selected={inspectorTab === 'review'}
                      className={`inspector-panel__tab${inspectorTab === 'review' ? ' inspector-panel__tab--active' : ''}`}
                      onClick={() => switchTab('review')}
                    >
                      审阅
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={inspectorTab === 'files'}
                      className={`inspector-panel__tab${inspectorTab === 'files' ? ' inspector-panel__tab--active' : ''}`}
                      onClick={() => switchTab('files')}
                    >
                      文件
                    </button>
                  </div>
                  <button
                    type="button"
                    className="inspector-icon-btn"
                    aria-label="关闭面板"
                    onClick={() => closeInspector()}
                  >
                    <CloseIcon size={14} />
                  </button>
                </header>
                <div className="inspector-panel__body">
                  {visitedReview && (
                    <div
                      className="inspector-panel__pane"
                      hidden={inspectorTab !== 'review'}
                      role="tabpanel"
                    >
                      <ReviewTab />
                    </div>
                  )}
                  {visitedFiles && (
                    <div
                      className="inspector-panel__pane"
                      hidden={inspectorTab !== 'files'}
                      role="tabpanel"
                    >
                      <FilesTab />
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </>
      )}
    </aside>
  )
}
