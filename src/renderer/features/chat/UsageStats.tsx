import React from 'react'
import { useAppStore } from '../../stores/useAppStore'

interface UsageStatsProps {
  /** compact: 旧的工具栏摘要；panel: hover 内的详细统计 */
  variant?: 'compact' | 'panel'
}

function formatTokenCount(n: number): string {
  if (n >= 100_000_000) return `${(n / 100_000_000).toFixed(1)}亿`
  if (n >= 10_000) return `${(n / 10_000).toFixed(1)}万`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return `${n}`
}

/**
 * UsageStats —— 会话级 token 用量统计
 *
 * - compact：旧的底部常驻摘要（保留兼容，当前默认不再使用）
 * - panel：放进 ContextIndicator hover，避免与“上下文容量”形成两套相似 UI
 */
export const UsageStats: React.FC<UsageStatsProps> = ({ variant = 'compact' }) => {
  const sessionUsage = useAppStore(state => state.sessionUsage)

  if (!sessionUsage || sessionUsage.totalPromptTokens === 0) {
    if (variant === 'panel') {
      return (
        <section className="context-usage context-usage--empty">
          <div className="context-usage__header">
            <span className="context-usage__title">本会话用量</span>
            <span className="context-usage__summary">暂无数据</span>
          </div>
          <p className="context-usage__hint">至少完成一轮模型调用后，才会累计输入、输出和缓存统计。</p>
        </section>
      )
    }
    return null
  }

  const hitPercent = (sessionUsage.hitRate * 100).toFixed(1)
  const totalInput = sessionUsage.totalPromptTokens || 1
  const readRatio = sessionUsage.totalCachedTokens / totalInput
  const writeRatio = sessionUsage.totalCacheWriteTokens / totalInput
  const totalUsage = sessionUsage.totalPromptTokens + sessionUsage.totalCompletionTokens

  if (variant === 'panel') {
    const rows = [
      { label: '输入', value: formatTokenCount(sessionUsage.totalPromptTokens) },
      { label: '输出', value: formatTokenCount(sessionUsage.totalCompletionTokens) },
      { label: '缓存命中', value: formatTokenCount(sessionUsage.totalCachedTokens) },
      { label: '缓存写入', value: formatTokenCount(sessionUsage.totalCacheWriteTokens) },
      { label: '总消耗', value: formatTokenCount(totalUsage) }
    ]

    return (
      <section className="context-usage">
        <div className="context-usage__header">
          <span className="context-usage__title">本会话用量</span>
          <span className="context-usage__summary">命中率 {hitPercent}%</span>
        </div>

        <div className="context-usage__bar" aria-hidden="true">
          <div
            className="context-usage__bar-hit"
            style={{ width: `${Math.min(readRatio * 100, 100)}%` }}
          />
          <div
            className="context-usage__bar-write"
            style={{ width: `${Math.min(writeRatio * 100, Math.max(0, 100 - readRatio * 100))}%` }}
          />
        </div>

        <div className="context-usage__grid">
          {rows.map(row => (
            <React.Fragment key={row.label}>
              <span className="context-usage__label">{row.label}</span>
              <span className="context-usage__value">{row.value}</span>
            </React.Fragment>
          ))}
        </div>
      </section>
    )
  }

  const totalK = (totalUsage / 1000).toFixed(1)
  const cacheWriteK = (sessionUsage.totalCacheWriteTokens / 1000).toFixed(1)

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
      <div className="usage-stats__bar">
        <div
          className="usage-stats__bar-hit"
          style={{ width: `${Math.min(readRatio * 100, 100)}%` }}
        />
        <div
          className="usage-stats__bar-write"
          style={{ width: `${Math.min(writeRatio * 100, Math.max(0, 100 - readRatio * 100))}%` }}
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
