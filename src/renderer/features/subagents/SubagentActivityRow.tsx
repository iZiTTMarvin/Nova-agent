/**
 * SubagentActivityRow — 子代理紧凑活动行（三段式）
 *
 * 1. 紧凑行：状态点 + 名称 +（模型 · 思考强度）+ 状态与耗时
 * 2. 次行：运行中显示当前动作（左→右呼吸微光），完成后翻转为结果摘要
 * 3. 终态且有文件改动时，下方出现会话级 diff 卡
 *
 * 点击整块在视口锚定的悬浮详情（SubagentDetailPopover）展开，不再跳转子会话。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { SubagentActivityProjection } from '../../../shared/subagents'
import { ToolTraceRow, type ToolTraceRowProps } from '../chat/ToolTraceRow'
import { InlinePermissionBar } from '../permissions/InlinePermissionBar'
import { useAgentStore } from '../../stores/useAgentStore'
import { ChevronIcon } from '../../components/Icons'
import {
  selectSubagentByParentToolCallId,
  selectLatestSubagentByChildSessionId,
  useSubagentProjectionStore
} from './projection'
import { SubagentDetailPopover } from './SubagentDetailPopover'
import { SubagentDiffCard } from './SubagentDiffCard'
import { formatSubagentModelParts } from './modelLine'
import { presentSubagentStatus } from './statusPresentation'
import { requestSubagentResume } from './resumeSubagentExecution'
import './SubagentActivityRow.css'

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
  type ResumeState = 'idle' | 'submitting' | 'waiting' | 'started' | 'failed'

  const active = isActive(projection.status)
  const [open, setOpen] = useState(false)
  const [anchor, setAnchor] = useState<PopoverAnchor | null>(null)
  const [now, setNow] = useState(Date.now())
  const containerRef = React.useRef<HTMLElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  const measureAnchor = useCallback((): PopoverAnchor | null => {
    const el = containerRef.current
    if (!el) return null
    const rect = el.getBoundingClientRect()
    return { top: rect.top, bottom: rect.bottom, left: rect.left, width: rect.width }
  }, [])

  const closePopover = useCallback(() => {
    setOpen(false)
    // 弹层卸载后焦点回到触发行，键盘用户不会落回页面顶部
    requestAnimationFrame(() => triggerRef.current?.focus())
  }, [])

  // 打开期间跟随锚定行：任一祖先滚动或窗口缩放后按帧重新取几何；行完全滚出视口则收起
  useEffect(() => {
    if (!open) return
    let frame = 0
    const schedule = (): void => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        const next = measureAnchor()
        if (!next) return
        if (next.bottom < 0 || next.top > window.innerHeight) {
          setOpen(false)
          return
        }
        setAnchor(next)
      })
    }
    window.addEventListener('scroll', schedule, true)
    window.addEventListener('resize', schedule)
    return () => {
      if (frame) cancelAnimationFrame(frame)
      window.removeEventListener('scroll', schedule, true)
      window.removeEventListener('resize', schedule)
    }
  }, [measureAnchor, open])

  const [resumeState, setResumeState] = useState<ResumeState>('idle')
  const [resumeRejection, setResumeRejection] = useState<string>('')
  const [stopError, setStopError] = useState('')
  const unsubscribeRef = useRef<(() => void) | null>(null)

  const latestProjection = useSubagentProjectionStore((state) =>
    selectLatestSubagentByChildSessionId(state, projection.childSessionId)
  )
  const isLatest = latestProjection?.childRunId === projection.childRunId

  const subscribeResumed = useCallback(() => {
    if (!projection.childRunId) return
    unsubscribeRef.current?.()
    const unsub = useSubagentProjectionStore.subscribe((state) => {
      // 续跑产生新 childRunId，通过 resumedFromRunId 反向定位旧 run 的接替者
      const updated = Object.values(state.byChildRunId).find(
        item => item.resumedFromRunId === projection.childRunId && item.status !== 'interrupted'
      )
      if (updated) setResumeState('started')
    })
    unsubscribeRef.current = unsub
  }, [projection.childRunId])

  useEffect(() => {
    return () => unsubscribeRef.current?.()
  }, [])

  /** 单独停止后台目标：只取消该 run，不影响父执行与兄弟任务；结果经权威快照回填。 */
  const handleStop = useCallback(async (targetRunId: string, label: string) => {
    setStopError('')
    try {
      await window.api.invoke('cancel-execution', { runId: targetRunId })
    } catch (error) {
      setStopError(`${label}失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }, [])

  const handleResume = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation()
    setResumeState('submitting')
    setResumeRejection('')
    const result = await requestSubagentResume({
      parentSessionId: projection.parentSessionId,
      childSessionId: projection.childSessionId,
      childRunId: projection.childRunId
    })
    if (result.ok) {
      setResumeState('waiting')
      subscribeResumed()
    } else {
      setResumeState('failed')
      setResumeRejection(result.rejection ?? '提交失败')
    }
  }, [projection, subscribeResumed])

  useEffect(() => {
    if (!active || !projection.startedAt) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [active, projection.startedAt])

  const status = presentSubagentStatus(projection.status)
  const elapsed = formatElapsed(
    projection.startedAt,
    active ? now : projection.completedAt ?? projection.startedAt ?? now
  )
  // 后台子代理的单独停止入口：父空闲也能停；同步子代理跟随父 turn 的中断入口
  const stopTarget =
    projection.execution === 'background_read_only' && active && projection.status !== 'cancelling'
      ? projection.childRunId
      : undefined
  const pendingRelayRunId = projection.pendingRelayRunId

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

  const modelParts = formatSubagentModelParts(projection)

  const visibleFileChanges = projection.fileChanges ?? []

  // 子代理权限请求在父会话视图中回应：权限条锚定到对应子代理活动行，
  // 按 pendingPermissionRequest.sessionId 与本行子会话 id 匹配。
  const anchoredPermissionRequest = useAgentStore((state) => {
    const request = state.pendingPermissionRequest
    return request && request.sessionId === projection.childSessionId ? request : null
  })
  const permissionInput = anchoredPermissionRequest?.toolName === 'shell_session'
    ? anchoredPermissionRequest.args.input
    : anchoredPermissionRequest?.args.command
  const permissionCommands = anchoredPermissionRequest?.commands?.length
    ? anchoredPermissionRequest.commands
    : typeof permissionInput === 'string' ? [permissionInput] : []

  const toggleOpen = (): void => {
    if (!open) setAnchor(measureAnchor())
    setOpen((value) => !value)
  }

  return (
    <section
      ref={containerRef}
      className={`subagent-activity-row subagent-activity-row--${status.tone}`}
    >
      <div className="subagent-activity-row__main">
        <button
          ref={triggerRef}
          type="button"
          className={`subagent-activity-row__trigger${open ? ' subagent-activity-row__trigger--open' : ''}`}
          onClick={toggleOpen}
          aria-expanded={open}
          aria-label={`子代理 ${projection.profile.name}，${status.label}${elapsed ? `，耗时 ${elapsed}` : ''}`}
        >
          <span className="subagent-activity-row__header">
            <span className="subagent-activity-row__dot" aria-hidden="true" />
            <span className="subagent-activity-row__agent">{projection.profile.name}</span>
            {projection.taskLabel && projection.taskLabel !== projection.profile.name && (
              <span className="subagent-activity-row__task-label" title={projection.taskLabel}>
                {projection.taskLabel}
              </span>
            )}
            {modelParts.length > 0 && (
              <span className="subagent-activity-row__model" title={modelParts.join(' ')}>
                {modelParts.map(part => (
                  <span key={part} className="subagent-model-part">{part}</span>
                ))}
              </span>
            )}
            <span className="subagent-activity-row__status">
              <span>{status.label}</span>
              {elapsed ? <span className="subagent-activity-row__elapsed">{elapsed}</span> : null}
            </span>
            <span className="subagent-activity-row__chevron" aria-hidden="true">
              <ChevronIcon size={12} direction="down" />
            </span>
          </span>
          <span
            className={`subagent-activity-row__activity${active ? ' subagent-activity-row__activity--live' : ''}`}
          >
            {activityLine}
          </span>
        </button>
      </div>

      {anchoredPermissionRequest && (
        <div className="subagent-activity-row__permission">
          <div className="subagent-activity-row__permission-label">子代理请求权限</div>
          {permissionCommands.length > 0 && (
            <pre className="subagent-activity-row__permission-command" aria-label="待授权命令">
              {permissionCommands.join('\n')}
            </pre>
          )}
          <InlinePermissionBar request={anchoredPermissionRequest} />
        </div>
      )}
      {(stopTarget || pendingRelayRunId) && (
        <div className="subagent-activity-row__actions">
          {stopTarget && (
            <button
              type="button"
              className="subagent-activity-row__stop-btn"
              onClick={() => void handleStop(stopTarget, '停止后台任务')}
            >
              停止后台任务
            </button>
          )}
          {pendingRelayRunId && (
            <button
              type="button"
              className="subagent-activity-row__stop-btn"
              onClick={() => void handleStop(pendingRelayRunId, '停止自动接力')}
            >
              停止自动接力
            </button>
          )}
          {stopError && <span className="subagent-activity-row__stop-error">{stopError}</span>}
        </div>
      )}

      {((projection.status === 'interrupted' && isLatest) || resumeState !== 'idle') && (
        <div className="subagent-activity-row__resume">
          {resumeState === 'idle' && (
            <button
              type="button"
              className="subagent-activity-row__resume-btn"
              onClick={handleResume}
            >
              继续此子任务
            </button>
          )}
          {resumeState === 'submitting' && (
            <span className="subagent-activity-row__resume-status">提交中…</span>
          )}
          {resumeState === 'waiting' && (
            <span className="subagent-activity-row__resume-status">已提交，等待父会话处理</span>
          )}
          {resumeState === 'failed' && (
            <button
              type="button"
              className="subagent-activity-row__resume-btn subagent-activity-row__resume-btn--danger"
              onClick={handleResume}
            >
              {`重试${resumeRejection ? ` (${resumeRejection})` : ''}`}
            </button>
          )}
          {resumeState === 'started' && (
            <span className="subagent-activity-row__resume-status">已开始</span>
          )}
        </div>
      )}

      {!active && visibleFileChanges.length > 0 && (
        <SubagentDiffCard projection={projection} />
      )}

      {open && anchor && createPortal(
        <SubagentDetailPopover
          projection={projection}
          anchor={anchor}
          onClose={closePopover}
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
