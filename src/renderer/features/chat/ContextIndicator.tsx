import React, { useMemo, useState, useRef, useEffect, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useSettingsStore } from '../../stores/useSettingsStore'
import { UsageStats } from './UsageStats'

/** 分项 token 行定义 */
interface BreakdownRow {
  key: 'systemPrompt' | 'skills' | 'tools' | 'messages' | 'other'
  label: string
  tokens: number
}

/**
 * 将 token 数量格式化为标准单位（K、M、B），避免出现「万」「亿」等非标准单位。
 * 例如: 460 -> 460, 1100 -> 1.1K, 200000 -> 200K, 1000000 -> 1M
 */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n >= 999_950_000) {
    return `${parseFloat((n / 1_000_000_000).toFixed(1))}B`
  }
  if (n >= 999_950) {
    return `${parseFloat((n / 1_000_000).toFixed(1))}M`
  }
  if (n >= 1_000) {
    return `${parseFloat((n / 1_000).toFixed(1))}K`
  }
  return `${Math.round(n)}`
}

const ROWS: Array<{ key: BreakdownRow['key']; label: string }> = [
  { key: 'messages', label: '消息' },
  { key: 'tools', label: '系统工具' },
  { key: 'skills', label: '技能' },
  { key: 'systemPrompt', label: '系统提示词' },
  { key: 'other', label: '其他' }
]

/** 渲染进度圆环的小图标,圆环底色走主题变量,进度色随占用率走语义 token */
const ContextRingIcon: React.FC<{ color: string; ratio: number }> = ({ color, ratio }) => {
  const size = 16
  const strokeWidth = 3
  const radius = (size - strokeWidth) / 2
  const circumference = 2 * Math.PI * radius
  const dashOffset = circumference * (1 - Math.min(1, Math.max(0, ratio)))
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="var(--border-warm)"
        strokeWidth={strokeWidth}
      />
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
        style={{ transition: 'stroke-dashoffset 0.3s ease' }}
      />
    </svg>
  )
}

interface PopoverGeometry {
  placement: 'left' | 'right'
  maxWidth: number
}

export const ContextIndicator: React.FC = () => {
  const contextLimit = useSettingsStore(state => state.contextLimit)
  const contextBreakdown = useSettingsStore(state => state.contextBreakdown)

  // 优先使用 breakdown 自带的 contextLimit(加载会话时直接计算的场景),
  // 回退到 store 的 contextLimit
  const effectiveLimit = contextBreakdown?.contextLimit ?? contextLimit
  const total = contextBreakdown?.totalEstimated ?? 0
  const ratio = effectiveLimit > 0 && total > 0 ? Math.min(total / effectiveLimit, 1) : 0
  const percent = total > 0 ? Math.round(ratio * 1000) / 10 : 0
  const getColor = () => {
    if (ratio >= 0.8) return 'var(--color-error)'
    if (ratio >= 0.5) return 'var(--color-accent)'
    return 'var(--color-success)'
  }
  const color = getColor()

  /** hover 触发(短延迟避免误触),离开容器再关 */
  const [isOpen, setIsOpen] = useState(false)
  const [geometry, setGeometry] = useState<PopoverGeometry>({ placement: 'right', maxWidth: 320 })
  const openTimer = useRef<number | null>(null)
  const closeTimer = useRef<number | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  /** 根据 composer 中心与视口剩余空间,决定 popover 向左还是向右展开,避免遮挡回到底部按钮 */
  const computeGeometry = useCallback(() => {
    const wrap = containerRef.current
    if (!wrap) return
    const wrapRect = wrap.getBoundingClientRect()
    const composer = wrap.closest('.chat-panel__composer-inner')
    const composerRect = composer?.getBoundingClientRect()
    const composerCenterX = composerRect
      ? composerRect.left + composerRect.width / 2
      : window.innerWidth / 2
    const iconCenterX = wrapRect.left + wrapRect.width / 2
    const preferRight = iconCenterX >= composerCenterX

    const margin = 12
    const minWidth = 180
    const maxPreferred = 320
    const rightSpace = window.innerWidth - wrapRect.right - margin
    const leftSpace = wrapRect.left - margin
    const rightFits = rightSpace >= minWidth
    const leftFits = leftSpace >= minWidth

    let placement: 'left' | 'right' = preferRight ? 'right' : 'left'
    if (placement === 'right' && !rightFits && leftFits) placement = 'left'
    if (placement === 'left' && !leftFits && rightFits) placement = 'right'

    const space = placement === 'right' ? rightSpace : leftSpace
    const maxWidth = Math.max(minWidth, Math.min(maxPreferred, space))
    setGeometry({ placement, maxWidth })
  }, [])

  const handleMouseEnter = useCallback(() => {
    if (closeTimer.current) {
      window.clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
    if (openTimer.current) window.clearTimeout(openTimer.current)
    computeGeometry()
    openTimer.current = window.setTimeout(() => setIsOpen(true), 80)
  }, [computeGeometry])

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

  /** popover 打开期间随窗口resize重新计算位置,避免拉伸后溢出 */
  useEffect(() => {
    if (!isOpen) return
    computeGeometry()
    const onResize = () => computeGeometry()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [isOpen, computeGeometry])

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
            className={`context-popover context-popover--${geometry.placement}`}
            style={{ maxWidth: geometry.maxWidth }}
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
                    <span className="context-popover__dot" data-key={row.key} aria-hidden="true" />
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
