import React, { useMemo, useState, useRef, useEffect, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useAppStore } from '../../stores/useAppStore'
import { UsageStats } from './UsageStats'

/** 分项 token 行定义 */
interface BreakdownRow {
  key: 'systemPrompt' | 'skills' | 'tools' | 'messages' | 'other'
  label: string
  tokens: number
}

/** 数字格式:>=1万显示 X.X万,>=1千显示 XK,否则原样 */
function formatTokens(n: number): string {
  if (n >= 100_000_000) return `${(n / 100_000_000).toFixed(1)}亿`
  if (n >= 10_000) return `${(n / 10_000).toFixed(1)}万`
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`
  return `${n}`
}

const ROWS: Array<{ key: BreakdownRow['key']; label: string }> = [
  { key: 'messages', label: '消息' },
  { key: 'tools', label: '系统工具' },
  { key: 'skills', label: '技能' },
  { key: 'systemPrompt', label: '系统提示词' },
  { key: 'other', label: '其他' }
]

/** 渲染进度圆环的小图标,无依赖 */
const ContextRingIcon: React.FC<{ color: string; ratio: number }> = ({ color, ratio }) => {
  const size = 16
  const strokeWidth = 3
  const radius = (size - strokeWidth) / 2
  const circumference = 2 * Math.PI * radius
  const dashOffset = circumference * (1 - Math.min(1, Math.max(0, ratio)))
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="#e5e7eb" strokeWidth={strokeWidth} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeDasharray={circumference}
        strokeDashoffset={dashOffset}
        strokeLinecap="round"
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        style={{ transition: 'stroke-dashoffset 0.3s ease, stroke 0.3s ease' }}
      />
    </svg>
  )
}

export const ContextIndicator: React.FC = () => {
  const contextLimit = useAppStore(state => state.contextLimit)
  const contextBreakdown = useAppStore(state => state.contextBreakdown)

  // 优先使用 breakdown 自带的 contextLimit(加载会话时直接计算的场景),
  // 回退到 store 的 contextLimit
  const effectiveLimit = contextBreakdown?.contextLimit ?? contextLimit
  const total = contextBreakdown?.totalEstimated ?? 0
  const ratio = effectiveLimit > 0 && total > 0 ? Math.min(total / effectiveLimit, 1) : 0
  const percent = total > 0 ? Math.round(ratio * 1000) / 10 : 0
  const getColor = () => {
    if (ratio >= 0.8) return '#ef4444'
    if (ratio >= 0.5) return '#f59e0b'
    return '#10b981'
  }
  const color = getColor()

  /** hover 触发(短延迟避免误触),离开容器再关 */
  const [isOpen, setIsOpen] = useState(false)
  const openTimer = useRef<number | null>(null)
  const closeTimer = useRef<number | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  const handleMouseEnter = useCallback(() => {
    if (closeTimer.current) {
      window.clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
    if (openTimer.current) window.clearTimeout(openTimer.current)
    openTimer.current = window.setTimeout(() => setIsOpen(true), 80)
  }, [])

  const handleMouseLeave = useCallback(() => {
    if (openTimer.current) {
      window.clearTimeout(openTimer.current)
      openTimer.current = null
    }
    if (closeTimer.current) window.clearTimeout(closeTimer.current)
    closeTimer.current = window.setTimeout(() => setIsOpen(false), 120)
  }, [])

  useEffect(() => {
    return () => {
      if (openTimer.current) window.clearTimeout(openTimer.current)
      if (closeTimer.current) window.clearTimeout(closeTimer.current)
    }
  }, [])

  /** 分项行:按 tokens 降序,百分比按 totalEstimated 算 */
  const rows = useMemo<Array<BreakdownRow & { percent: string }>>(() => {
    if (!contextBreakdown || total === 0) return []
    const bd = contextBreakdown.breakdown
    return ROWS
      .map(r => ({
        ...r,
        tokens: bd[r.key] ?? 0,
        percent: total > 0 ? ((bd[r.key] ?? 0) / total * 100).toFixed(1) : '0.0'
      }))
      .sort((a, b) => b.tokens - a.tokens)
  }, [contextBreakdown, total])

  return (
    <div
      ref={containerRef}
      className="context-indicator-wrap"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <div
        className="context-indicator"
        style={{ color }}
        aria-label={`上下文容量 ${percent}%`}
      >
        <ContextRingIcon color={color} ratio={ratio} />
      </div>

      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, y: 6, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.96 }}
            transition={{ duration: 0.14, ease: 'easeOut' }}
            className="context-popover"
            onMouseEnter={handleMouseEnter}
            onMouseLeave={handleMouseLeave}
          >
            {/* 顶部:标题 + 总量 */}
            <div className="context-popover__header">
              <span className="context-popover__title">上下文容量</span>
              <span className="context-popover__total">
                {total > 0
                  ? `${formatTokens(total)} / ${formatTokens(effectiveLimit)}`
                  : '等待 LLM 调用…'}
                {total > 0 && <span className="context-popover__pct"> ({percent}%)</span>}
              </span>
            </div>

            {/* 进度条 */}
            <div className="context-popover__bar">
              <div
                className="context-popover__bar-fill"
                style={{ width: `${Math.min(100, ratio * 100)}%`, background: color }}
              />
            </div>

            {/* 分项列表 */}
            {rows.length > 0 && (
              <ul className="context-popover__list">
                {rows.map(row => (
                  <li key={row.key} className="context-popover__row">
                    <span className="context-popover__dot" aria-hidden="true" />
                    <span className="context-popover__label">{row.label}</span>
                    <span className="context-popover__value">{formatTokens(row.tokens)}</span>
                    <span className="context-popover__pct">{row.percent}%</span>
                  </li>
                ))}
              </ul>
            )}

            <UsageStats variant="panel" />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
