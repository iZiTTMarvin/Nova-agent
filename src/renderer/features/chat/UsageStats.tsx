import React from 'react'
import { useSettingsStore } from '../../stores/useSettingsStore'
import type { SessionUsageStats } from '../../stores/types'

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

/** 单个 profile 桶的明细行 */
function ProfileUsageRows({ stats }: { stats: SessionUsageStats }): React.ReactElement {
  const totalUsage =
    stats.totalPromptTokens + stats.totalCompletionTokens + stats.totalCacheWriteTokens
  const rows = [
    { label: '输入', value: formatTokenCount(stats.totalPromptTokens) },
    { label: '输出', value: formatTokenCount(stats.totalCompletionTokens) },
    { label: '缓存命中', value: formatTokenCount(stats.totalCachedTokens) },
    // miss 仅在 provider 确有报告时展示，不得把 undefined 显示成 0
    ...(stats.totalCacheMissTokens !== undefined
      ? [{ label: '缓存未命中', value: formatTokenCount(stats.totalCacheMissTokens) }]
      : []),
    { label: '缓存写入', value: formatTokenCount(stats.totalCacheWriteTokens) },
    { label: '总消耗', value: formatTokenCount(totalUsage) }
  ]

  return (
    <div className="context-usage__grid">
      {rows.map(row => (
        <React.Fragment key={row.label}>
          <span className="context-usage__label">{row.label}</span>
          <span className="context-usage__value">{row.value}</span>
        </React.Fragment>
      ))}
    </div>
  )
}

/**
 * UsageStats —— 会话级 token 用量统计
 *
 * - compact：旧的底部常驻摘要（保留兼容，当前默认不再使用）
 * - panel：放进 ContextIndicator hover；按 cacheProfileId 分桶展示
 * - 无 usage 时显示「未报告」，绝不把未知当 0 命中
 */
export const UsageStats: React.FC<UsageStatsProps> = ({ variant = 'compact' }) => {
  const sessionUsage = useSettingsStore(state => state.sessionUsage)
  const sessionUsageByProfile = useSettingsStore(state => state.sessionUsageByProfile)

  const profileEntries = Object.entries(sessionUsageByProfile)
  const hasData = Boolean(sessionUsage && sessionUsage.totalPromptTokens > 0)

  if (!hasData) {
    if (variant === 'panel') {
      return (
        <section className="context-usage context-usage--empty">
          <div className="context-usage__header">
            <span className="context-usage__title">本会话用量</span>
            <span className="context-usage__summary">未报告</span>
          </div>
          <p className="context-usage__hint">
            provider 尚未返回 usage；不会把未知显示为 0 命中或未命中。
          </p>
        </section>
      )
    }
    return null
  }

  const hitPercent = (sessionUsage!.hitRate * 100).toFixed(1)
  const totalInput = sessionUsage!.totalPromptTokens + sessionUsage!.totalCacheWriteTokens || 1
  const readRatio = sessionUsage!.totalCachedTokens / totalInput
  const writeRatio = sessionUsage!.totalCacheWriteTokens / totalInput
  const totalUsage =
    sessionUsage!.totalPromptTokens +
    sessionUsage!.totalCompletionTokens +
    sessionUsage!.totalCacheWriteTokens

  if (variant === 'panel') {
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
            style={{
              width: `${Math.min(writeRatio * 100, Math.max(0, 100 - readRatio * 100))}%`
            }}
          />
        </div>

        {profileEntries.length <= 1 ? (
          // 单桶：保持原有扁平明细（兼容 ContextIndicator 断言）
          <ProfileUsageRows stats={sessionUsage!} />
        ) : (
          // 多桶：按 profile 分开展示，避免 fallback 后指标混在一起
          profileEntries.map(([profileId, stats]) => (
            <div key={profileId} className="context-usage__profile">
              <div className="context-usage__profile-header">
                <span className="context-usage__profile-id">{profileId}</span>
                <span className="context-usage__profile-hit">
                  命中率 {(stats.hitRate * 100).toFixed(1)}%
                </span>
              </div>
              <ProfileUsageRows stats={stats} />
            </div>
          ))
        )}
      </section>
    )
  }

  const totalK = (totalUsage / 1000).toFixed(1)
  const cacheWriteK = (sessionUsage!.totalCacheWriteTokens / 1000).toFixed(1)

  return (
    <div
      className="usage-stats"
      title={[
        `输入: ${sessionUsage!.totalPromptTokens.toLocaleString()} tokens`,
        `输出: ${sessionUsage!.totalCompletionTokens.toLocaleString()} tokens`,
        `缓存命中(read): ${sessionUsage!.totalCachedTokens.toLocaleString()} tokens`,
        `缓存写入(write): ${sessionUsage!.totalCacheWriteTokens.toLocaleString()} tokens`
      ].join('\n')}
    >
      <div className="usage-stats__bar">
        <div
          className="usage-stats__bar-hit"
          style={{ width: `${Math.min(readRatio * 100, 100)}%` }}
        />
        <div
          className="usage-stats__bar-write"
          style={{
            width: `${Math.min(writeRatio * 100, Math.max(0, 100 - readRatio * 100))}%`
          }}
        />
      </div>
      <span className="usage-stats__hit">{hitPercent}%</span>
      <span className="usage-stats__sep">·</span>
      <span className="usage-stats__total">{totalK}k</span>
      {sessionUsage!.totalCacheWriteTokens > 0 && (
        <>
          <span className="usage-stats__sep">·</span>
          <span className="usage-stats__write">w:{cacheWriteK}k</span>
        </>
      )}
    </div>
  )
}
