/**
 * TurnProcessTree — L1/L2/L3 回合折叠树容器
 *
 * L1 Worked for → L2 Thought + 摘要条 → L3 原子轨迹（条件 mount）
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronIcon } from '../../components/Icons'
import { TurnProcessCollapsible } from './TurnProcessCollapsible'
import { ProcessTraceList } from './ProcessTraceList'
import { formatL1Header, formatL2DiffSuffix, formatL2Summary } from './turnSummaryDisplay'
import { selectForceExpandedForMessage } from './turnProcessSelectors'
import { useAgentStore } from '../../stores/useAgentStore'
import { useComposeStore } from '../compose/useComposeStore'
import type { TurnRenderModel } from './turnProcessModel'
import type { Mode } from '../../../shared/session/types'
import type { RendererMessageBlock } from '../../stores/types'
import './TurnProcessTree.css'

export interface TurnProcessTreeProps {
  model: TurnRenderModel
  messageId: string
  isLive: boolean
  interrupted?: boolean
  currentMode: Mode
  isCurrentAssistantGenerating: boolean
  onRenderPoolTick?: () => void
  isTurnActiveForThisMsg: boolean
  isPausedForInput: boolean
  blocks: RendererMessageBlock[]
  turnStartedAt?: number
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

export const TurnProcessTree: React.FC<TurnProcessTreeProps> = React.memo(function TurnProcessTree({
  model,
  messageId,
  isLive,
  interrupted = false,
  currentMode,
  isCurrentAssistantGenerating,
  onRenderPoolTick,
  isTurnActiveForThisMsg,
  isPausedForInput,
  blocks,
  turnStartedAt
}) {
  const reducedMotion = usePrefersReducedMotion()
  const userL1ToggledRef = useRef(false)
  const userL2ToggledRef = useRef(false)
  const prevIsLiveRef = useRef(isLive)

  // live 默认全展开；completed 默认全折叠
  const [userL1Open, setUserL1Open] = useState(isLive)
  const [userL2Open, setUserL2Open] = useState(isLive)
  const [liveElapsedMs, setLiveElapsedMs] = useState<number | undefined>(model.durationMs)

  const agentForceExpanded = useAgentStore(state =>
    selectForceExpandedForMessage(state, messageId, isLive)
  )
  const composeForceExpanded = useComposeStore(state => isLive && !!state.pendingAskUser)
  const forceExpanded = agentForceExpanded || composeForceExpanded

  const l1Open = forceExpanded ? true : userL1Open
  const l2Open = forceExpanded ? true : userL2Open

  // live → completed：未手动操作时自动收 L1/L2
  useEffect(() => {
    const wasLive = prevIsLiveRef.current
    prevIsLiveRef.current = isLive

    if (wasLive && !isLive) {
      if (!userL1ToggledRef.current) setUserL1Open(false)
      if (!userL2ToggledRef.current) setUserL2Open(false)
    }
    if (isLive && !wasLive) {
      if (!userL1ToggledRef.current) setUserL1Open(true)
      if (!userL2ToggledRef.current) setUserL2Open(true)
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

  const toggleL1 = useCallback(() => {
    if (forceExpanded) return
    userL1ToggledRef.current = true
    setUserL1Open(prev => !prev)
  }, [forceExpanded])

  const toggleL2 = useCallback(() => {
    if (forceExpanded) return
    userL2ToggledRef.current = true
    setUserL2Open(prev => !prev)
  }, [forceExpanded])

  const l1Title = formatL1Header({
    phase: model.phase,
    durationMs: model.durationMs,
    elapsedMs: liveElapsedMs,
    interrupted
  })

  const l2Summary = formatL2Summary(model.summary)
  const l2Diff = formatL2DiffSuffix(model.summary)
  const thoughtPreview = model.summary.thoughtPreview

  return (
    <div className="turn-process-tree" data-testid="turn-process-tree">
      {/* L1 头：始终 mount */}
      <button
        type="button"
        className="turn-process-tree__l1"
        onClick={toggleL1}
        aria-expanded={l1Open}
        data-testid="turn-process-l1"
      >
        <span className="turn-process-tree__l1-title">{l1Title}</span>
        <ChevronIcon
          size={12}
          direction={l1Open ? 'down' : 'right'}
          className="turn-process-tree__chevron"
        />
      </button>

      {/* L2 区域：L1 折叠时不 mount */}
      <TurnProcessCollapsible open={l1Open} reducedMotion={reducedMotion} className="turn-process-tree__l2-wrap">
        <div className="turn-process-tree__l2">
          {thoughtPreview && (
            <div className="turn-process-tree__thought-preview" title={thoughtPreview}>
              {thoughtPreview}
            </div>
          )}

          <button
            type="button"
            className="turn-process-tree__l2-bar"
            onClick={toggleL2}
            aria-expanded={l2Open}
            data-testid="turn-process-l2"
          >
            <span className="turn-process-tree__l2-summary">{l2Summary}</span>
            <span
              className={`turn-process-tree__l2-diff tabular-nums${
                l2Diff.isPlaceholder ? ' turn-process-tree__l2-diff--placeholder' : ''
              }`}
            >
              {l2Diff.text}
            </span>
            <ChevronIcon
              size={12}
              direction={l2Open ? 'down' : 'right'}
              className="turn-process-tree__chevron"
            />
          </button>

          {/* L3：L2 展开时直接挂载，不再套动画壳（避免空白区） */}
          {l2Open && (
            <ProcessTraceList
              segments={model.processTimeline}
              messageId={messageId}
              blocks={blocks}
              isTurnActiveForThisMsg={isTurnActiveForThisMsg}
              isPausedForInput={isPausedForInput}
              isCurrentAssistantGenerating={isCurrentAssistantGenerating}
              onRenderPoolTick={onRenderPoolTick}
            />
          )}
        </div>
      </TurnProcessCollapsible>
    </div>
  )
})
