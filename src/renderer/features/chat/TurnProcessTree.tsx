/**
 * TurnProcessTree — 回合工作区折叠容器
 *
 * 单层结构：「已工作 X 分 X 秒」折叠头 + 过程时间线（折叠时不 mount）。
 * 最终结论文案不在此容器内，由 MessageItem 以正文样式单独渲染。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronIcon } from '../../components/Icons'
import { TurnProcessCollapsible } from './TurnProcessCollapsible'
import { ProcessTraceList } from './ProcessTraceList'
import { formatWorkedHeader, MISSING_ANSWER_TEXT } from './turnSummaryDisplay'
import type { PendingPlanReview } from '../../../shared/planReview'
import type { TurnRenderModel, TurnTimelineSegment } from './turnProcessModel'
import type { RendererMessageBlock } from '../../stores/types'
import './TurnProcessTree.css'

export interface TurnProcessTreeProps {
  model: TurnRenderModel
  messageId: string
  isLive: boolean
  interrupted?: boolean
  isCurrentAssistantGenerating: boolean
  onRenderPoolTick?: () => void
  isTurnActiveForThisMsg: boolean
  isPausedForInput: boolean
  blocks: RendererMessageBlock[]
  sessionId?: string | null
  pendingPlanReview?: PendingPlanReview | null
  turnStartedAt?: number
  persistedUserOpen?: boolean
  onUserOpenChange?: (open: boolean) => void
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false)
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return
    }
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    setReduced(mq.matches)
    const handler = () => setReduced(mq.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])
  return reduced
}

function groupTimeline(timeline: TurnTimelineSegment[]): Array<{
  display: TurnTimelineSegment['display']
  segments: TurnTimelineSegment[]
}> {
  const groups: Array<{
    display: TurnTimelineSegment['display']
    segments: TurnTimelineSegment[]
  }> = []
  for (const segment of timeline) {
    const current = groups.at(-1)
    if (current?.display === segment.display) current.segments.push(segment)
    else groups.push({ display: segment.display, segments: [segment] })
  }
  return groups
}

export const TurnProcessTree: React.FC<TurnProcessTreeProps> = React.memo(function TurnProcessTree({
  model,
  messageId,
  isLive,
  interrupted = false,
  isCurrentAssistantGenerating,
  onRenderPoolTick,
  isTurnActiveForThisMsg,
  isPausedForInput,
  blocks,
  sessionId,
  pendingPlanReview,
  turnStartedAt,
  persistedUserOpen,
  onUserOpenChange
}) {
  const reducedMotion = usePrefersReducedMotion()
  const userToggledRef = useRef(persistedUserOpen !== undefined)
  const prevIsLiveRef = useRef(isLive)

  // live 默认展开；completed 默认折叠
  const [userOpen, setUserOpen] = useState(persistedUserOpen ?? isLive)
  const [liveElapsedMs, setLiveElapsedMs] = useState<number | undefined>(model.durationMs)

  // live 阶段过程区不套折叠壳、头部不可点击，等待审批/问答时内容天然可见；
  // 此处 open 只服务于 completed 阶段的折叠壳。
  const open = userOpen

  // live → completed：未手动操作时自动收起；重新 live 时自动展开
  useEffect(() => {
    const wasLive = prevIsLiveRef.current
    prevIsLiveRef.current = isLive

    if (wasLive !== isLive && !userToggledRef.current) {
      setUserOpen(isLive)
    }
  }, [isLive])

  // live 计时刷新
  useEffect(() => {
    if (!isLive || turnStartedAt === undefined) return
    const tick = () => setLiveElapsedMs(Date.now() - turnStartedAt)
    tick()
    const timer = setInterval(tick, 1000)
    return () => clearInterval(timer)
  }, [isLive, turnStartedAt])

  const toggle = useCallback(() => {
    userToggledRef.current = true
    setUserOpen(prev => {
      const next = !prev
      onUserOpenChange?.(next)
      return next
    })
  }, [onUserOpenChange])

  const headerTitle = formatWorkedHeader({
    phase: model.phase,
    durationMs: model.durationMs,
    elapsedMs: liveElapsedMs,
    interrupted
  })

  const groups = groupTimeline(model.timeline)
  const trace = (segments: TurnTimelineSegment[]) => (
    <ProcessTraceList
      segments={segments}
      messageId={messageId}
      blocks={blocks}
      sessionId={sessionId}
      pendingPlanReview={pendingPlanReview}
      isTurnActiveForThisMsg={isTurnActiveForThisMsg}
      isPausedForInput={isPausedForInput}
      isCurrentAssistantGenerating={isCurrentAssistantGenerating}
      onRenderPoolTick={onRenderPoolTick}
    />
  )

  return (
    <div className={`turn-process-tree${isLive ? ' turn-process-tree--live' : ''}`} data-testid="turn-process-tree">
      {isLive ? (
        <div className="turn-process-tree__status" data-testid="turn-process-header">
          {headerTitle}
        </div>
      ) : model.hasProcess ? (
        <button
          type="button"
          className="turn-process-tree__header"
          onClick={toggle}
          aria-expanded={open}
          data-testid="turn-process-header"
        >
          <span className="turn-process-tree__header-title">{headerTitle}</span>
          <ChevronIcon
            size={12}
            direction={open ? 'down' : 'right'}
            className="turn-process-tree__chevron"
          />
        </button>
      ) : null}

      {groups.map((group, index) => group.display === 'persistent' ? (
        <React.Fragment key={`persistent-${index}`}>{trace(group.segments)}</React.Fragment>
      ) : isLive ? (
        <React.Fragment key={`process-${index}`}>{trace(group.segments)}</React.Fragment>
      ) : (
        <TurnProcessCollapsible
          key={`process-${index}`}
          open={open}
          reducedMotion={reducedMotion}
          className="turn-process-tree__body"
        >
          {trace(group.segments)}
        </TurnProcessCollapsible>
      ))}

      {model.missingAnswer && !interrupted && (
        <div className="turn-process-tree__no-summary" data-testid="turn-no-summary">
          {MISSING_ANSWER_TEXT}
        </div>
      )}
    </div>
  )
})
