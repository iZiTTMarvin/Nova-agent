/**
 * 剪贴板复制与状态衰减 Hook：点击复制后展示勾选态，并在恢复前进入平滑缩放消退阶段。
 */
import { useCallback, useEffect, useRef, useState } from 'react'

export interface UseCopyFeedbackOptions {
  totalDurationMs?: number
  decayDurationMs?: number
}

export interface CopyFeedbackState {
  copied: boolean
  isDecaying: boolean
  copy: (text: string) => void
}

export function useCopyFeedback(options: UseCopyFeedbackOptions = {}): CopyFeedbackState {
  const { totalDurationMs = 2000, decayDurationMs = 350 } = options
  const [copied, setCopied] = useState(false)
  const [isDecaying, setIsDecaying] = useState(false)
  const decayTimerRef = useRef<number | null>(null)
  const resetTimerRef = useRef<number | null>(null)

  const clearTimers = useCallback(() => {
    if (decayTimerRef.current !== null) {
      window.clearTimeout(decayTimerRef.current)
      decayTimerRef.current = null
    }
    if (resetTimerRef.current !== null) {
      window.clearTimeout(resetTimerRef.current)
      resetTimerRef.current = null
    }
  }, [])

  useEffect(() => clearTimers, [clearTimers])

  const copy = useCallback(
    (text: string) => {
      if (typeof navigator === 'undefined' || !navigator.clipboard) return
      navigator.clipboard.writeText(text).then(
        () => {
          clearTimers()
          setCopied(true)
          setIsDecaying(false)
          const decayStartMs = Math.max(0, totalDurationMs - decayDurationMs)
          decayTimerRef.current = window.setTimeout(() => {
            setIsDecaying(true)
          }, decayStartMs)
          resetTimerRef.current = window.setTimeout(() => {
            setIsDecaying(false)
            setCopied(false)
          }, totalDurationMs)
        },
        () => {}
      )
    },
    [clearTimers, decayDurationMs, totalDurationMs]
  )

  return { copied, isDecaying, copy }
}
