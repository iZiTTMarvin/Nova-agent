/**
 * 折叠壳：条件 mount 门控（P5 硬性要求）。
 *
 * 不使用 framer-motion 高度动画——Electron 下 measure + height:auto 易留下
 * 「有高度无内容」的空白区（嵌套 L1/L2 时尤其明显）。
 */
import React from 'react'

interface TurnProcessCollapsibleProps {
  open: boolean
  /** 保留 API 兼容；当前实现统一走即时 mount/unmount */
  reducedMotion?: boolean
  className?: string
  children: React.ReactNode
}

export const TurnProcessCollapsible: React.FC<TurnProcessCollapsibleProps> = React.memo(
  function TurnProcessCollapsible({ open, className, children }) {
    if (!open) return null
    return <div className={className}>{children}</div>
  }
)
