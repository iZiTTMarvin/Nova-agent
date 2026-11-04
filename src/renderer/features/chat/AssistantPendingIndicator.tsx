import React, { useEffect, useState } from 'react'
import { isTerminalRunStatus, type RunSnapshot } from '../../../shared/run/types'
import { usePrefersReducedMotion } from '../../hooks/usePrefersReducedMotion'
import { NovaWorkingOrb } from './NovaWorkingOrb'
import { formatDurationMs } from './turnSummaryDisplay'
import './AssistantPendingIndicator.css'

export const NOVA_WORKING_MESSAGES = [
  'Nova正在捣鼓中...',
  '老板来了，Nova敲代码的速度更快了...',
  '正在加班中...',
  'Nova正在翻代码，马上回来...',
  '正在和Bug讲道理...',
  'Nova正在把思路焊起来...',
  '正在摸清这个仓库的脾气...',
  '代码在路上，Nova正在收尾...',
  '认真干活中，一步一步来...',
  'Nova正在让这段代码听话一点...'
] as const

export type NovaWorkingMessage = (typeof NOVA_WORKING_MESSAGES)[number]

const MESSAGE_INTERVAL_MS = 4600

export function pickNonRepeatingWorkingMessage(
  previous: NovaWorkingMessage | null,
  random: () => number = Math.random
): NovaWorkingMessage {
  const previousIndex = previous === null
    ? -1
    : NOVA_WORKING_MESSAGES.indexOf(previous)
  const candidateCount = previousIndex >= 0
    ? NOVA_WORKING_MESSAGES.length - 1
    : NOVA_WORKING_MESSAGES.length
  const normalizedRandom = Math.min(0.999999, Math.max(0, random()))
  let candidateIndex = Math.floor(normalizedRandom * candidateCount)

  if (previousIndex >= 0 && candidateIndex >= previousIndex) {
    candidateIndex += 1
  }

  return NOVA_WORKING_MESSAGES[candidateIndex]
}

/**
 * 由权威运行快照推出读屏用的阶段文案；视觉层展示轮播工作文案。
 * 等待授权、提问与停止由各自的卡片表达，流尾不在这些阶段出现。
 */
export function describeRunPhase(snapshot: RunSnapshot | null | undefined): string {
  // 新一轮尚未建立运行（只有上一轮的终态快照）时，界面处于发送阶段
  if (!snapshot || isTerminalRunStatus(snapshot.status)) return '正在发送'
  switch (snapshot.status) {
    case 'queued':
      return '排队中'
    case 'retrying':
      return '正在重试'
    case 'resuming':
      return '正在恢复'
    default:
      break
  }
  const executing = snapshot.toolCommits?.filter(record => record.phase === 'executing') ?? []
  if (executing.length > 1) return `正在执行 ${executing.length} 个工具`
  if (executing.length === 1) return `正在执行 ${executing[0]!.toolName}`
  return '正在思考'
}

export interface AssistantPendingIndicatorProps {
  /** 轮次起始时间戳（毫秒）；用于平滑展示运行时钟 */
  turnStartedAt?: number
  /** 读屏播报的阶段文案，缺省为「正在思考」 */
  label?: string
}

/** 流尾状态指示器：在 Agent 运行时稳稳挂在整个消息流最下方。 */
export const AssistantPendingIndicator: React.FC<AssistantPendingIndicatorProps> = ({
  turnStartedAt,
  label = '正在思考'
}) => {
  const [mountedAt] = useState(() => Date.now())
  const anchor = turnStartedAt ?? mountedAt
  const [elapsedMs, setElapsedMs] = useState(() => Math.max(0, Date.now() - anchor))
  const [workingMessage, setWorkingMessage] = useState<NovaWorkingMessage>(() =>
    pickNonRepeatingWorkingMessage(null)
  )
  const reducedMotion = usePrefersReducedMotion()

  useEffect(() => {
    const tick = () => {
      setElapsedMs(Math.max(0, Date.now() - anchor))
    }
    tick()
    const timer = window.setInterval(tick, 1000)
    return () => window.clearInterval(timer)
  }, [anchor])

  useEffect(() => {
    if (reducedMotion) return undefined
    const timer = window.setInterval(() => {
      setWorkingMessage(previous => pickNonRepeatingWorkingMessage(previous))
    }, MESSAGE_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [reducedMotion])

  const showClock = elapsedMs >= 15_000

  return (
    <div className="assistant-pending nova-working-indicator">
      <NovaWorkingOrb size={26} />
      {/* 读屏只播报真实阶段；轮播文案与每秒走动的时钟不进 live region，避免反复打断 */}
      <span className="assistant-pending__label" role="status" aria-live="polite">
        {label}
      </span>
      <span
        key={workingMessage}
        className="nova-working-indicator__copy"
        aria-hidden="true"
      >
        {workingMessage}
      </span>
      {showClock && (
        <span className="nova-working-indicator__clock" aria-hidden="true">
          {formatDurationMs(elapsedMs)}
        </span>
      )}
    </div>
  )
}
