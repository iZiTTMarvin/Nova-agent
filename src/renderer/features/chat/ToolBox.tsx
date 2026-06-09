import React, { useState } from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import { CheckIcon, AlertIcon, TerminalIcon, ChevronIcon } from '../../components/Icons'
import { isPermissionDeniedResult } from './renderingPolicy'
import { getToolDisplayName, getToolSummary } from './toolDisplay'

/** 折叠式工具调用状态卡片 */
export interface ToolBoxProps {
  name: string
  args: Record<string, unknown>
  status: 'running' | 'success' | 'error'
  result?: string
  /** 是否处于 assistant 流式生成中。true 时启用入场动画。 */
  isLiveStreaming?: boolean
}

/**
 * 流式入场动画参数。
 *
 * 职责分工：opacity 由 CSS @keyframes tool-box-live-enter 驱动（96ms，64% 处 opacity 1），
 * scale 由 framer-motion spring 驱动。两者独立可关：CSS 层通过 prefers-reduced-motion，
 * framer-motion 层通过 useReducedMotion hook。
 */
export const LIVE_ENTER_SPRING = { type: 'spring' as const, stiffness: 300, damping: 30, mass: 0.8 }
export const NO_ANIMATION = { duration: 0 }

export const ToolBox: React.FC<ToolBoxProps> = React.memo(function ToolBox({ name, args, status, result, isLiveStreaming = false }) {
  const [isOpen, setIsOpen] = useState(false)
  const shouldHideArguments = isPermissionDeniedResult(result)
  const summary = getToolSummary(name, args)

  /** 系统偏好 + framer-motion 层的双重门控：减少动效时跳过 spring */
  const prefersReducedMotion = useReducedMotion()
  const animateLive = isLiveStreaming && !prefersReducedMotion

  const renderStatusIcon = () => {
    switch (status) {
      case 'running':
        return (
          <div className="tool-box__status-icon tool-box__status-icon--running">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
              <line x1="12" y1="2" x2="12" y2="6" />
              <line x1="12" y1="18" x2="12" y2="22" />
              <line x1="4.93" y1="4.93" x2="7.76" y2="7.76" />
              <line x1="16.24" y1="16.24" x2="19.07" y2="19.07" />
              <line x1="2" y1="12" x2="6" y2="12" />
              <line x1="18" y1="12" x2="22" y2="12" />
              <line x1="4.93" y1="19.07" x2="7.76" y2="16.24" />
              <line x1="16.24" y1="7.76" x2="19.07" y2="4.93" />
            </svg>
          </div>
        )
      case 'success':
        return (
          <div className="tool-box__status-icon tool-box__status-icon--success">
            <CheckIcon size={14} />
          </div>
        )
      case 'error':
        return (
          <div className="tool-box__status-icon tool-box__status-icon--error">
            <AlertIcon size={14} />
          </div>
        )
      default:
        return null
    }
  }

  return (
    <motion.div
      initial={animateLive ? { scale: 0.98 } : false}
      animate={{ scale: 1 }}
      transition={animateLive ? LIVE_ENTER_SPRING : NO_ANIMATION}
      className={isLiveStreaming ? 'tool-box tool-box--live-enter' : 'tool-box'}
    >
      <div className="tool-box__header" onClick={() => setIsOpen(!isOpen)}>
        {renderStatusIcon()}
        <TerminalIcon size={14} style={{ color: 'var(--text-secondary)' }} />
        <span className="tool-box__title">{getToolDisplayName(name)}</span>
        {summary && <span className="tool-box__summary">{summary}</span>}
        <div className="tool-box__arrow">
          <ChevronIcon size={14} direction={isOpen ? 'up' : 'down'} />
        </div>
      </div>

      {isOpen && (
        <div className="tool-box__body">
          {!shouldHideArguments && (
            <div className="tool-box__section">
              <div className="tool-box__sec-title">调用参数</div>
              <pre className="tool-box__content">
                {JSON.stringify(args, null, 2)}
              </pre>
            </div>
          )}

          {result && (
            <div className="tool-box__section">
              <div className="tool-box__sec-title">执行结果</div>
              <pre className="tool-box__content">{result}</pre>
            </div>
          )}
        </div>
      )}
    </motion.div>
  )
})
