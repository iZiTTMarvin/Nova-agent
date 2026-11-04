/**
 * Inspector 左缘分隔线：自己画 1px 结构线并提供拖拽热区；
 * 指针靠近时在线上亮起一段紫色渐变光，随指针纵向移动。可聚焦，用方向键调整宽度。
 */
import React, { useCallback, useRef } from 'react'
import './InspectorResizeHandle.css'

export interface InspectorResizeHandleProps {
  onMouseDown: (e: React.MouseEvent) => void
  onDoubleClick?: () => void
  onKeyDown?: (e: React.KeyboardEvent<HTMLElement>) => void
  /** 当前宽度与可调范围，供读屏读出 */
  valueNow: number
  valueMin: number
  valueMax: number
  /** 拖拽进行中保持光效常亮 */
  active?: boolean
}

export const InspectorResizeHandle: React.FC<InspectorResizeHandleProps> = ({
  onMouseDown,
  onDoubleClick,
  onKeyDown,
  valueNow,
  valueMin,
  valueMax,
  active = false
}) => {
  const ref = useRef<HTMLDivElement>(null)

  // 光点位置只写 CSS 变量，不走 React 状态，避免指针移动触发重渲染
  const trackPointer = useCallback((e: React.MouseEvent) => {
    const el = ref.current
    if (!el) return
    el.style.setProperty('--glow-y', `${e.clientY - el.getBoundingClientRect().top}px`)
  }, [])

  return (
    <div
      ref={ref}
      className={`inspector-panel__resize${active ? ' inspector-panel__resize--active' : ''}`}
      role="separator"
      aria-orientation="vertical"
      aria-label="调整面板宽度（方向键调整，Home/End 到最小/最大，Enter 或双击恢复默认，拖拽中按 Escape 还原）"
      aria-valuenow={Math.round(valueNow)}
      aria-valuemin={Math.round(valueMin)}
      aria-valuemax={Math.round(valueMax)}
      tabIndex={0}
      onMouseDown={onMouseDown}
      onDoubleClick={onDoubleClick}
      onKeyDown={onKeyDown}
      onMouseEnter={trackPointer}
      onMouseMove={trackPointer}
    />
  )
}
