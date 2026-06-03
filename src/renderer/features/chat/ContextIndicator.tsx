import React, { useMemo } from 'react'
import { useAppStore } from '../../stores/useAppStore'
import type { ExtendedMessage } from '../../stores/useAppStore'

/** 粗略估算文本的 token 数（char/4） */
function estimateTokens(text: string): number {
  if (!text) return 0
  return Math.ceil(text.length / 4)
}

/** 估算当前会话上下文的总 token 数 */
function estimateContextTokens(messages: ExtendedMessage[]): number {
  let total = 0
  for (const msg of messages) {
    if (msg.role === 'system') continue
    total += estimateTokens(msg.content)
    if (msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        total += estimateTokens(typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments))
        if (tc.result) total += estimateTokens(tc.result)
      }
    }
  }
  return total
}

/** 将数字格式化为 K/M 单位 */
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`
  return `${n}`
}

export const ContextIndicator: React.FC = () => {
  const messages = useAppStore(state => state.messages)
  const contextLimit = useAppStore(state => state.contextLimit)

  const contextTokens = useMemo(() => estimateContextTokens(messages), [messages])
  const ratio = contextLimit > 0 ? Math.min(contextTokens / contextLimit, 1) : 0
  const percent = Math.round(ratio * 100)
  const threshold = Math.floor(contextLimit * 0.8)
  const remainingPercent = Math.max(0, Math.round((threshold - contextTokens) / contextLimit * 100))

  // 颜色分级
  const getColor = () => {
    if (ratio >= 0.8) return '#ef4444' // 红色
    if (ratio >= 0.5) return '#f59e0b' // 橙色
    return '#10b981' // 绿色
  }

  const color = getColor()
  const size = 16
  const strokeWidth = 3
  const radius = (size - strokeWidth) / 2
  const circumference = 2 * Math.PI * radius
  const dashOffset = circumference * (1 - ratio)

  return (
    <div className="context-indicator" title={`上下文: ${formatTokens(contextTokens)} / ${formatTokens(contextLimit)} (${percent}%)\n${formatTokens(threshold)} (80%) 时自动压缩\n还剩 ${remainingPercent}%`}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        {/* 背景圆环 */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="#e5e7eb"
          strokeWidth={strokeWidth}
        />
        {/* 进度圆环 */}
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
    </div>
  )
}
