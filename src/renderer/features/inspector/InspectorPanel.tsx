/**
 * 右侧 Inspector 面板：审阅 / 文件 Tab，宽度可拖拽。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { CloseIcon } from '../../components/Icons'
import { useLayoutStore } from '../../stores/useLayoutStore'
import type { InspectorTab as InspectorTabId } from '../../stores/useLayoutStore'
import { ReviewTab } from './ReviewTab'
import { FilesTab } from './FilesTab'
import './InspectorPanel.css'

const WIDTH_TRANSITION = 'width var(--transition-normal), opacity var(--transition-normal)'

export const InspectorPanel: React.FC = () => {
  const inspectorOpen = useLayoutStore(s => s.inspectorOpen)
  const inspectorTab = useLayoutStore(s => s.inspectorTab)
  const inspectorWidth = useLayoutStore(s => s.inspectorWidth)
  const setInspectorTab = useLayoutStore(s => s.setInspectorTab)
  const closeInspector = useLayoutStore(s => s.closeInspector)
  const setInspectorWidth = useLayoutStore(s => s.setInspectorWidth)

  const [mounted, setMounted] = useState(false)
  const [visitedReview, setVisitedReview] = useState(false)
  const [visitedFiles, setVisitedFiles] = useState(false)
  const [dragging, setDragging] = useState(false)
  const dragStartX = useRef(0)
  const dragStartWidth = useRef(0)

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

  const onResizeMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      dragStartX.current = e.clientX
      dragStartWidth.current = useLayoutStore.getState().inspectorWidth
      setDragging(true)
      document.body.style.userSelect = 'none'
      document.body.style.cursor = 'col-resize'
    },
    []
  )

  useEffect(() => {
    if (!dragging) return

    const onMove = (e: MouseEvent) => {
      const delta = dragStartX.current - e.clientX
      setInspectorWidth(dragStartWidth.current + delta)
    }
    const onUp = () => {
      setDragging(false)
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
    }
  }, [dragging, setInspectorWidth])

  const width = inspectorOpen ? inspectorWidth : 0
  const showContent = mounted && inspectorOpen

  const switchTab = (tab: InspectorTabId) => {
    setInspectorTab(tab)
  }

  return (
    <aside
      className={`inspector-panel${inspectorOpen ? ' inspector-panel--open' : ''}${dragging ? ' inspector-panel--dragging' : ''}`}
      style={{
        width,
        transition: dragging ? 'none' : WIDTH_TRANSITION,
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
          <div className="inspector-panel__inner">
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
          </div>
        </>
      )}
    </aside>
  )
}
