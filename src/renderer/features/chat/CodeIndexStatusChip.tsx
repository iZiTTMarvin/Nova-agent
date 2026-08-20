import React from 'react'
import {
  selectCurrentCodeIndexStatus,
  useCodeIndexStore
} from '../../stores/useCodeIndexStore'
import { useSettingsStore } from '../../stores/useSettingsStore'

export const CodeIndexStatusChip: React.FC = () => {
  const snapshot = useCodeIndexStore(selectCurrentCodeIndexStatus)
  const openSettings = useSettingsStore(state => state.openCodeIndexSettings)

  if (!snapshot?.enabled) return null

  if (snapshot.status === 'building') {
    const completed = snapshot.progress?.completed ?? 0
    const total = snapshot.progress?.total ?? snapshot.coverage.eligibleFiles
    const hasProgress = total > 0
    const ratio = total > 0 ? completed / total : 0
    return (
      <span
        className="code-index-status-chip"
        aria-label={hasProgress ? `建立代码索引 ${completed}/${total}` : '建立代码索引'}
      >
        <CodeIndexRing ratio={ratio} />
        <span>{hasProgress ? `建立代码索引 ${completed}/${total}` : '建立代码索引'}</span>
      </span>
    )
  }

  if (snapshot.status === 'degraded' || snapshot.status === 'unavailable') {
    return (
      <button
        type="button"
        className="code-index-status-chip code-index-status-chip--warning"
        onClick={openSettings}
        title="打开代码索引设置"
      >
        <span className="code-index-status-chip__warning-dot" aria-hidden="true" />
        <span>代码索引不可用</span>
      </button>
    )
  }

  return null
}

function CodeIndexRing({ ratio }: { ratio: number }) {
  const size = 16
  const strokeWidth = 3
  const radius = (size - strokeWidth) / 2
  const circumference = 2 * Math.PI * radius
  const normalized = Math.min(1, Math.max(0, ratio))
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
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
        stroke="var(--color-accent)"
        strokeWidth={strokeWidth}
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - normalized)}
        strokeLinecap="round"
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </svg>
  )
}
