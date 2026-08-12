import React, { useEffect, useState } from 'react'
import { NovaWorkingOrb } from './NovaWorkingOrb'
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
  '认真干活中，摸鱼进程已暂停...',
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

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** 当前 assistant 轮次仍在运行时展示 Nova 工作状态。 */
export const AssistantPendingIndicator: React.FC = () => {
  const [workingMessage, setWorkingMessage] = useState<NovaWorkingMessage>(() =>
    pickNonRepeatingWorkingMessage(null)
  )

  useEffect(() => {
    if (prefersReducedMotion()) return undefined

    const timer = window.setInterval(() => {
      setWorkingMessage(previous => pickNonRepeatingWorkingMessage(previous))
    }, MESSAGE_INTERVAL_MS)

    return () => window.clearInterval(timer)
  }, [])

  return (
    <div
      className="assistant-pending nova-working-indicator"
      role="status"
      aria-live="polite"
    >
      <NovaWorkingOrb size={28} />
      <span className="assistant-pending__label">正在思考</span>
      <span
        key={workingMessage}
        className="nova-working-indicator__copy"
        aria-hidden="true"
      >
        {workingMessage}
      </span>
    </div>
  )
}
