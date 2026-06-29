import React from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import { getToolDisplayName, getToolSummary } from './toolDisplay'

/**
 * AskQuestionToolCard —— askQuestion 专用轻量状态卡片
 *
 * 职责：
 * - 在消息流中显示 "询问用户" 的运行/完成状态
 * - 不承载交互，不折叠，不展开 JSON 参数
 * - 标题和摘要由 toolDisplay 提供
 */
export interface AskQuestionToolCardProps {
  /** 工具调用 id，用于 React key */
  toolCallId?: string
  /** 工具参数 */
  args: Record<string, unknown>
  /** 执行状态 */
  status: 'running' | 'success' | 'error'
  /** 是否处于 assistant 流式生成中。true 时启用入场动画。 */
  isLiveStreaming?: boolean
}

/** 流式入场动画参数，与 ToolBox 保持一致 */
export const LIVE_ENTER_SPRING = { type: 'spring' as const, stiffness: 300, damping: 30, mass: 0.8 }
export const NO_ANIMATION = { duration: 0 }

export const AskQuestionToolCard: React.FC<AskQuestionToolCardProps> = React.memo(function AskQuestionToolCard({
  args,
  status,
  isLiveStreaming = false
}) {
  const title = getToolDisplayName('askQuestion')
  const summary = getToolSummary('askQuestion', args)
  const prefersReducedMotion = useReducedMotion()
  const animateLive = isLiveStreaming && !prefersReducedMotion

  const renderStatusIcon = () => {
    switch (status) {
      case 'running':
        return (
          <div className="ask-question-tool-card__icon ask-question-tool-card__icon--running">
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
          <div className="ask-question-tool-card__icon ask-question-tool-card__icon--success">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          </div>
        )
      case 'error':
        return (
          <div className="ask-question-tool-card__icon ask-question-tool-card__icon--error">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
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
      className={isLiveStreaming ? 'ask-question-tool-card ask-question-tool-card--live-enter' : 'ask-question-tool-card'}
    >
      <div className="ask-question-tool-card__header">
        {renderStatusIcon()}
        <span className="ask-question-tool-card__title">{title}</span>
        {summary && <span className="ask-question-tool-card__summary">{summary}</span>}
      </div>
    </motion.div>
  )
})
