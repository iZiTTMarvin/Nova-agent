import React from 'react'
import { useSettingsStore } from '../../stores/useSettingsStore'

interface UsageStatsProps {
  /** compact: 旧的工具栏摘要；panel: hover 内的用量摘要 */
  variant?: 'compact' | 'panel'
}

/**
 * UsageStats —— 会话级缓存命中率摘要
 *
 * - 对外只展示会话平均命中率，避免本轮/明细/诊断造成信息过载
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
            <span className="context-usage__title">平均缓存命中率</span>
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
  const denom =
    sessionUsage!.totalUncachedInputTokens +
      sessionUsage!.totalCacheReadTokens +
      sessionUsage!.totalCacheWriteTokens || 1
  const readRatio = sessionUsage!.totalCacheReadTokens / denom
  const writeRatio = sessionUsage!.totalCacheWriteTokens / denom

  if (variant === 'panel') {
    return (
      <section className="context-usage">
        <div className="context-usage__header">
          <span className="context-usage__title">平均缓存命中率</span>
          <span className="context-usage__summary">{hitPercent}%</span>
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

        {profileEntries.length > 1 &&
          profileEntries.map(([profileId, stats]) => (
            <div key={profileId} className="context-usage__profile">
              <div className="context-usage__profile-header">
                <span className="context-usage__profile-id">{profileId}</span>
                <span className="context-usage__profile-hit">
                  {(stats.hitRate * 100).toFixed(1)}%
                </span>
              </div>
            </div>
          ))}
      </section>
    )
  }

  return (
    <div
      className="usage-stats"
      title={`平均缓存命中率: ${hitPercent}%`}
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
    </div>
  )
}
