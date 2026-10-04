/**
 * Inspector 左缘分隔线：自己画 1px 结构线并提供拖拽热区；
 * 指针靠近时在线上亮起一段紫色渐变光，随指针纵向移动。
 */
import React, { useCallback, useRef } from 'react'
import './InspectorResizeHandle.css'

export interface InspectorResizeHandleProps {
  onMouseDown: (e: React.MouseEvent) => void
  /** 拖拽进行中保持光效常亮 */
  active?: boolean
}

export const InspectorResizeHandle: React.FC<InspectorResizeHandleProps> = ({ onMouseDown, active = false }) => {
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
      aria-label="调整面板宽度"
      onMouseDown={onMouseDown}
      onMouseEnter={trackPointer}
      onMouseMove={trackPointer}
    />
  )
}
