import React from 'react'
import { useAppStore } from '../../stores/useAppStore'

/**
 * 轻量 token 用量统计组件
 * 显示当前会话的缓存命中率、token 消耗和缓存写入量，嵌入输入框底部工具栏
 */
export const UsageStats: React.FC = () => {
  const sessionUsage = useAppStore(state => state.sessionUsage)

  if (!sessionUsage || sessionUsage.totalPromptTokens === 0) return null

  const hitPercent = (sessionUsage.hitRate * 100).toFixed(1)
  const totalK = ((sessionUsage.totalPromptTokens + sessionUsage.totalCompletionTokens) / 1000).toFixed(1)
  const cacheWriteK = (sessionUsage.totalCacheWriteTokens / 1000).toFixed(1)

  // 缓存比例条：直观展示 cache_read vs cache_write vs 未缓存 的比例
  const totalInput = sessionUsage.totalPromptTokens || 1
  const readRatio = sessionUsage.totalCachedTokens / totalInput
  const writeRatio = sessionUsage.totalCacheWriteTokens / totalInput

  return (
    <div
      className="usage-stats"
      title={[
        `输入: ${sessionUsage.totalPromptTokens.toLocaleString()} tokens`,
        `输出: ${sessionUsage.totalCompletionTokens.toLocaleString()} tokens`,
        `缓存命中(read): ${sessionUsage.totalCachedTokens.toLocaleString()} tokens`,
        `缓存写入(write): ${sessionUsage.totalCacheWriteTokens.toLocaleString()} tokens`
      ].join('\n')}
    >
      {/* 缓存比例条 */}
      <div className="usage-stats__bar">
        <div
          className="usage-stats__bar-hit"
          style={{ width: `${Math.min(readRatio * 100, 100)}%` }}
        />
        <div
          className="usage-stats__bar-write"
          style={{ width: `${Math.min(writeRatio * 100, 100 - readRatio * 100)}%` }}
        />
      </div>
      <span className="usage-stats__hit">{hitPercent}%</span>
      <span className="usage-stats__sep">·</span>
      <span className="usage-stats__total">{totalK}k</span>
      {sessionUsage.totalCacheWriteTokens > 0 && (
        <>
          <span className="usage-stats__sep">·</span>
          <span className="usage-stats__write">w:{cacheWriteK}k</span>
        </>
      )}
    </div>
  )
}
