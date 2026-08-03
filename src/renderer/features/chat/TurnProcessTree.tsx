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
import { formatWorkedHeader } from './turnSummaryDisplay'
import { selectForceExpandedForMessage } from './turnProcessSelectors'
import { useAgentStore } from '../../stores/useAgentStore'
import type { TurnRenderModel } from './turnProcessModel'
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

  const agentForceExpanded = useAgentStore(state =>
    selectForceExpandedForMessage(state, messageId, isLive)
  )
  const forceExpanded = agentForceExpanded

  const open = forceExpanded ? true : userOpen

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
    if (forceExpanded) return
    userToggledRef.current = true
    setUserOpen(prev => {
      const next = !prev
      onUserOpenChange?.(next)
      return next
    })
  }, [forceExpanded, onUserOpenChange])

  const headerTitle = formatWorkedHeader({
    phase: model.phase,
    durationMs: model.durationMs,
    elapsedMs: liveElapsedMs,
    interrupted
  })

  return (
    <div className="turn-process-tree" data-testid="turn-process-tree">
      {/* 原生 disclosure 头：Astryx Button 内容居中，不适合全宽折叠头 */}
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

      {/* 过程时间线：折叠时不 mount */}
      <TurnProcessCollapsible open={open} reducedMotion={reducedMotion} className="turn-process-tree__body">
        <ProcessTraceList
          segments={model.processTimeline}
          messageId={messageId}
          blocks={blocks}
          isTurnActiveForThisMsg={isTurnActiveForThisMsg}
          isPausedForInput={isPausedForInput}
          isCurrentAssistantGenerating={isCurrentAssistantGenerating}
          onRenderPoolTick={onRenderPoolTick}
        />
      </TurnProcessCollapsible>
    </div>
  )
})
