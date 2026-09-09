/**
 * TurnProcessTree — 回合工作区折叠容器
 *
 * 单层结构：「已工作 X 分 X 秒」折叠头 + 过程时间线。
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
  persistedUserOpen,
  onUserOpenChange
}) {
  const reducedMotion = usePrefersReducedMotion()
  const headerRef = useRef<HTMLButtonElement>(null)
  const userToggledRef = useRef(persistedUserOpen !== undefined)
  const prevIsLiveRef = useRef(isLive)

  // 中断保留阅读现场；历史中断轮次也默认展示过程。
  const [userOpen, setUserOpen] = useState(persistedUserOpen ?? (isLive || interrupted))
  const open = userOpen

  // 只有正常完成才自动收起，停止不改变展开状态。
  useEffect(() => {
    const wasLive = prevIsLiveRef.current
    prevIsLiveRef.current = isLive

    if (wasLive !== isLive && !userToggledRef.current && (isLive || !interrupted)) {
      setUserOpen(isLive)
    }
  }, [isLive, interrupted])

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
    durationMs: model.durationMs
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
      {!isLive && model.hasProcess ? (
        <button
          ref={headerRef}
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
      ) : (
        <TurnProcessCollapsible
          key={`process-${index}`}
          open={isLive || open}
          reducedMotion={reducedMotion}
          className="turn-process-tree__body"
          pinHeaderRef={headerRef}
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
