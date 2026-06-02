import React from 'react'
import { useAppStore } from '../../stores/useAppStore'

/**
 * 轻量 token 用量统计组件
 * 显示当前会话的缓存命中率和 token 消耗，嵌入输入框底部工具栏
 */
export const UsageStats: React.FC = () => {
  const sessionUsage = useAppStore(state => state.sessionUsage)

  if (!sessionUsage || sessionUsage.totalPromptTokens === 0) return null

  const hitPercent = (sessionUsage.hitRate * 100).toFixed(1)
  const totalK = ((sessionUsage.totalPromptTokens + sessionUsage.totalCompletionTokens) / 1000).toFixed(1)

  return (
    <div className="usage-stats" title={`输入: ${sessionUsage.totalPromptTokens.toLocaleString()} tokens\n输出: ${sessionUsage.totalCompletionTokens.toLocaleString()} tokens\n缓存命中: ${sessionUsage.totalCachedTokens.toLocaleString()} tokens`}>
      <span className="usage-stats__hit">{hitPercent}%</span>
      <span className="usage-stats__sep">·</span>
      <span className="usage-stats__total">{totalK}k</span>
    </div>
  )
}
