/**
 * SubagentActivityRow — 子代理紧凑活动行（三段式）
 *
 * 1. 紧凑行：状态点 + 名称 +（模型 · 思考强度）+ 状态与耗时
 * 2. 次行：运行中显示当前动作（左→右呼吸微光），完成后翻转为结果摘要
 * 3. 终态且有文件改动时，下方出现会话级 diff 卡
 *
 * 点击整块在视口锚定的悬浮详情（SubagentDetailPopover）展开，不再跳转子会话。
 */
import React, { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import type { SubagentActivityProjection } from '../../../shared/subagents'
import { ToolTraceRow, type ToolTraceRowProps } from '../chat/ToolTraceRow'
import {
  selectSubagentByParentToolCallId,
  useSubagentProjectionStore
} from './projection'
import { SubagentDetailPopover } from './SubagentDetailPopover'
import { SubagentDiffCard } from './SubagentDiffCard'
import { formatSubagentModelLine } from './modelLine'
import './SubagentActivityRow.css'

interface StatusPresentation {
  label: string
  tone: 'running' | 'attention' | 'success' | 'error' | 'muted'
}

function presentStatus(status: SubagentActivityProjection['status']): StatusPresentation {
  switch (status) {
    case 'queued':
      return { label: '等待开始', tone: 'running' }
    case 'running':
    case 'retrying':
    case 'resuming':
      return { label: status === 'retrying' ? '正在重试' : '正在工作', tone: 'running' }
    case 'waiting_user':
      return { label: '等待授权', tone: 'attention' }
    case 'cancelling':
      return { label: '正在停止', tone: 'running' }
    case 'completed':
      return { label: '已完成', tone: 'success' }
    case 'failed':
      return { label: '失败', tone: 'error' }
    case 'cancelled':
      return { label: '已取消', tone: 'muted' }
    case 'interrupted':
      return { label: '已中断', tone: 'attention' }
    case 'record_missing':
      return { label: '记录不可用', tone: 'muted' }
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

/** 弹窗锚定的行几何（打开瞬间的视口坐标；面板用 fixed 定位避开滚动容器裁剪） */
export interface PopoverAnchor {
  top: number
  bottom: number
  left: number
  width: number
}

export interface SubagentActivityRowProps {
  projection: SubagentActivityProjection
  fallbackResult?: string
}

export const SubagentActivityRow: React.FC<SubagentActivityRowProps> = ({
  projection,
  fallbackResult
}) => {
  const active = isActive(projection.status)
  const [open, setOpen] = useState(false)
  const [anchor, setAnchor] = useState<PopoverAnchor | null>(null)
  const [now, setNow] = useState(Date.now())
  const containerRef = React.useRef<HTMLElement>(null)

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

  /** 次行文案：运行态展示当前动作，终态翻转为结果/失败/回退文案。 */
  const activityLine = useMemo(() => {
    if (projection.status === 'failed') {
      return projection.failure?.message ?? projection.summary ?? '子代理执行失败'
    }
    if (projection.status === 'record_missing') {
      return fallbackResult || '子代理运行记录不可用；父工具结果仍保留。'
    }
    if (active) {
      return projection.latestActivity || '正在准备工具与上下文…'
    }
    return projection.summary ?? projection.latestActivity ?? ''
  }, [active, fallbackResult, projection])

  const modelLine = formatSubagentModelLine(projection)

  const visibleFileChanges = projection.fileChanges ?? []

  const toggleOpen = (): void => {
    if (!open && containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect()
      setAnchor({ top: rect.top, bottom: rect.bottom, left: rect.left, width: rect.width })
    }
    setOpen((value) => !value)
  }

  return (
    <section
      ref={containerRef}
      className={`subagent-activity-row subagent-activity-row--${status.tone}`}
    >
      <div className="subagent-activity-row__main">
        <button
          type="button"
          className={`subagent-activity-row__trigger${open ? ' subagent-activity-row__trigger--open' : ''}`}
          onClick={toggleOpen}
          aria-expanded={open}
          aria-label={`子代理 ${projection.profile.name}，${status.label}${elapsed ? `，耗时 ${elapsed}` : ''}`}
        >
          <span className="subagent-activity-row__header">
            <span className="subagent-activity-row__dot" aria-hidden="true" />
            <span className="subagent-activity-row__agent">{projection.profile.name}</span>
            {modelLine && <span className="subagent-activity-row__model">{modelLine}</span>}
            <span className="subagent-activity-row__status">
              {status.label}{elapsed ? ` · ${elapsed}` : ''}
            </span>
            <span className="subagent-activity-row__chevron" aria-hidden="true">
              {open ? '▾' : '▸'}
            </span>
          </span>
          <span
            className={`subagent-activity-row__activity${active ? ' subagent-activity-row__activity--live' : ''}`}
          >
            {activityLine}
          </span>
        </button>
      </div>

      {!active && visibleFileChanges.length > 0 && (
        <SubagentDiffCard projection={projection} />
      )}

      {open && anchor && createPortal(
        <SubagentDetailPopover
          projection={projection}
          anchor={anchor}
          onClose={() => setOpen(false)}
        />,
        document.body
      )}
    </section>
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
