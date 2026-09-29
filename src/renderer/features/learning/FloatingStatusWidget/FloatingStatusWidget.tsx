import React, { useEffect, useRef, useState } from 'react'
import './FloatingStatusWidget.css'

export interface FloatingStatusWidgetProps {
  /** 胶囊形态渲染内容（图标、短文本、Badge 等） */
  capsule: React.ReactNode
  /** 展开卡片标题 */
  title: React.ReactNode
  /** 展开卡片副标题或状态徽标 */
  badge?: React.ReactNode
  /** 展开卡片右上角额外操作区（如更多菜单） */
  headerActions?: React.ReactNode
  /** 卡片主体内容 */
  children: React.ReactNode
  /** 可选卡片底部操作区 */
  footer?: React.ReactNode
  /** 是否受控展开 */
  expanded?: boolean
  /** 默认展开状态 */
  defaultExpanded?: boolean
  /** 展开状态改变回调 */
  onExpandedChange?: (expanded: boolean) => void
  /** 额外样式类名 */
  className?: string
  /** 胶囊按钮的 aria-label */
  capsuleAriaLabel?: string
  /** 卡片区域的 aria-label */
  cardAriaLabel?: string
}

/**
 * 1:1 对标 ZCode 的通用悬浮状态组件
 * 悬浮在主内容工作区右上角，支持在胶囊态（Pill）与展开卡片态（Card）之间平滑切换。
 */
export function FloatingStatusWidget({
  capsule,
  title,
  badge,
  headerActions,
  children,
  footer,
  expanded: controlledExpanded,
  defaultExpanded = false,
  onExpandedChange,
  className = '',
  capsuleAriaLabel = '展开状态面板',
  cardAriaLabel = '状态面板'
}: FloatingStatusWidgetProps): React.ReactElement {
  const [internalExpanded, setInternalExpanded] = useState(defaultExpanded)
  const isControlled = controlledExpanded !== undefined
  const isExpanded = isControlled ? controlledExpanded : internalExpanded

  const containerRef = useRef<HTMLDivElement>(null)
  const capsuleRef = useRef<HTMLButtonElement>(null)

  const setExpanded = (nextExpanded: boolean) => {
    if (!isControlled) {
      setInternalExpanded(nextExpanded)
    }
    onExpandedChange?.(nextExpanded)
  }

  // 点击卡片外部时自动收起
  useEffect(() => {
    if (!isExpanded) return

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null
      if (containerRef.current && !containerRef.current.contains(target)) {
        setExpanded(false)
      }
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setExpanded(false)
        capsuleRef.current?.focus()
      }
    }

    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [isExpanded])

  return (
    <div
      ref={containerRef}
      className={`floating-status-widget ${isExpanded ? 'floating-status-widget--expanded' : 'floating-status-widget--collapsed'} ${className}`}
    >
      {!isExpanded ? (
        <button
          ref={capsuleRef}
          type="button"
          className="floating-status-widget__capsule"
          aria-label={capsuleAriaLabel}
          aria-expanded={false}
          onClick={() => setExpanded(true)}
        >
          {capsule}
          <span className="floating-status-widget__capsule-arrow" aria-hidden="true">▾</span>
        </button>
      ) : (
        <div
          className="floating-status-widget__card"
          role="region"
          aria-label={cardAriaLabel}
        >
          <div className="floating-status-widget__header">
            <div className="floating-status-widget__title-group">
              <span className="floating-status-widget__title">{title}</span>
              {badge && <span className="floating-status-widget__badge">{badge}</span>}
            </div>
            <div className="floating-status-widget__actions">
              {headerActions}
              <button
                type="button"
                className="floating-status-widget__action-btn"
                title="收起为胶囊"
                aria-label="收起为胶囊"
                onClick={() => {
                  setExpanded(false)
                  capsuleRef.current?.focus()
                }}
              >
                {/* 类似 ZCode 右上角折叠/缩放图标 */}
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
                </svg>
              </button>
            </div>
          </div>
          <div className="floating-status-widget__body">
            {children}
          </div>
          {footer && (
            <div className="floating-status-widget__footer">
              {footer}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
