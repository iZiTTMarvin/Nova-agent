import React, { useEffect, useMemo, useState } from 'react'
import type { SubagentActivityProjection } from '../../../shared/subagents'
import { useChatStore } from '../../stores/useChatStore'
import { ToolTraceRow, type ToolTraceRowProps } from '../chat/ToolTraceRow'
import {
  selectSubagentByParentToolCallId,
  useSubagentProjectionStore
} from './projection'
import './SubagentActivityRow.css'

interface StatusPresentation {
  icon: string
  label: string
  tone: 'running' | 'attention' | 'success' | 'error' | 'muted'
}

function presentStatus(status: SubagentActivityProjection['status']): StatusPresentation {
  switch (status) {
    case 'queued':
      return { icon: '○', label: '等待开始', tone: 'running' }
    case 'running':
    case 'retrying':
    case 'resuming':
      return { icon: '●', label: status === 'retrying' ? '正在重试' : '正在工作', tone: 'running' }
    case 'waiting_user':
      return { icon: '!', label: '等待授权', tone: 'attention' }
    case 'cancelling':
      return { icon: '◌', label: '正在停止', tone: 'running' }
    case 'completed':
      return { icon: '✓', label: '已完成', tone: 'success' }
    case 'failed':
      return { icon: '×', label: '失败', tone: 'error' }
    case 'cancelled':
      return { icon: '■', label: '已取消', tone: 'muted' }
    case 'interrupted':
      return { icon: '◇', label: '已中断', tone: 'attention' }
    case 'record_missing':
      return { icon: '?', label: '记录不可用', tone: 'muted' }
  }
}

function isActive(status: SubagentActivityProjection['status']): boolean {
  return (
    status === 'queued' ||
    status === 'running' ||
    status === 'waiting_user' ||
    status === 'retrying' ||
    status === 'resuming' ||
    status === 'cancelling'
  )
}

function formatElapsed(startedAt: number | undefined, endedAt: number): string | null {
  if (!startedAt) return null
  const seconds = Math.max(0, Math.floor((endedAt - startedAt) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return rest > 0 ? `${minutes}m ${rest}s` : `${minutes}m`
}

export interface SubagentActivityRowProps {
  projection: SubagentActivityProjection
  fallbackResult?: string
}

export const SubagentActivityRow: React.FC<SubagentActivityRowProps> = ({
  projection,
  fallbackResult
}) => {
  const selectSession = useChatStore((state) => state.selectSession)
  const active = isActive(projection.status)
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    if (!active || !projection.startedAt) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [active, projection.startedAt])

  const status = presentStatus(projection.status)
  const elapsed = formatElapsed(
    projection.startedAt,
    active ? now : projection.completedAt ?? projection.startedAt ?? now
  )
  const summary = useMemo(() => {
    if (projection.status === 'failed') {
      return projection.failure?.message ?? projection.summary ?? '子代理执行失败'
    }
    if (projection.status === 'record_missing') {
      return fallbackResult || '子代理运行记录不可用；父工具结果仍保留。'
    }
    return projection.summary ?? projection.latestActivity
  }, [fallbackResult, projection])

  return (
    <button
      type="button"
      className={`subagent-activity-row subagent-activity-row--${status.tone}`}
      onClick={() => void selectSession(projection.childSessionId)}
      aria-label={`打开子代理 ${projection.profile.name}，${status.label}`}
    >
      <span className="subagent-activity-row__glyph" aria-hidden="true">{status.icon}</span>
      <span className="subagent-activity-row__body">
        <span className="subagent-activity-row__task" title={projection.taskLabel}>
          {projection.taskLabel}
        </span>
        <span className="subagent-activity-row__headline">
          <span className="subagent-activity-row__agent">{projection.profile.name}</span>
          <span className="subagent-activity-row__status">
            {status.label}{elapsed ? ` · ${elapsed}` : ''}
          </span>
        </span>
        <span className="subagent-activity-row__meta">
          {projection.profile.permissionCeiling === 'read_only' ? '只读' : '工作区写入'}
          {summary ? <span className="subagent-activity-row__summary">{summary}</span> : null}
        </span>
        {projection.artifactCount > 0 ? (
          <span className="subagent-activity-row__artifacts">{projection.artifactCount} 个产物</span>
        ) : null}
      </span>
      <span className="subagent-activity-row__open" aria-hidden="true">打开 ›</span>
    </button>
  )
}

export interface SubagentToolRowProps extends ToolTraceRowProps {
  toolCallId: string
}

/** 新 task 有结构化 lineage 时渲染 Activity Row；旧历史保持普通工具行。 */
export const SubagentToolRow: React.FC<SubagentToolRowProps> = (props) => {
  const projection = useSubagentProjectionStore((state) =>
    selectSubagentByParentToolCallId(state, props.toolCallId)
  )
  if (!projection) return <ToolTraceRow {...props} />
  return <SubagentActivityRow projection={projection} fallbackResult={props.result} />
}
