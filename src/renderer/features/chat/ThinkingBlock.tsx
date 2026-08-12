/**
 * ThinkingBlock — 「Thought for Xs」轻量折叠行
 *
 * 进行中默认展开，结束后自动收起（用户手动点过则尊重其选择）。
 * 耗时优先读块上持久化的 durationMs，其次 thinkingTimingMemory，最后本地计时兜底；
 * 三者皆无（如重启前的旧消息）视为未知，标题不显示耗时。
 */
import React, { useState, useEffect, useMemo, useRef } from 'react'
import { ChevronIcon } from '../../components/Icons'
import { MarkdownRenderer } from './MarkdownRenderer'
import {
  markThinkingEndedForMessage,
  markThinkingStarted,
  readThinkingElapsedSec
} from '../../lib/thinkingTimingMemory'
import { normalizeThinkingForDisplay } from './turnProcessModel'
import './ThinkingBlock.css'

interface ThinkingBlockProps {
  thinking: string
  active?: boolean
  /** 用于读取流式边界写入的耗时；与 blockIndex 成对传入 */
  messageId?: string
  blockIndex?: number
  /** 持久化在 thinking 块上的耗时（毫秒）；重启后仍可用 */
  durationMs?: number
}

function formatElapsed(seconds: number): string {
  if (seconds <= 0) return '0s'
  if (seconds < 10) return `${seconds.toFixed(1)}s`
  return `${Math.round(seconds)}s`
}

function resolveDisplayElapsedSec(options: {
  durationMs?: number
  messageId?: string
  blockIndex?: number
  localElapsed: number | null
}): number | null {
  const { durationMs, messageId, blockIndex, localElapsed } = options
  if (typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs > 0) {
    return durationMs / 1000
  }
  if (messageId !== undefined && blockIndex !== undefined) {
    const remembered = readThinkingElapsedSec(messageId, blockIndex)
    if (remembered !== null) return remembered
  }
  return localElapsed
}

export const ThinkingBlock: React.FC<ThinkingBlockProps> = React.memo(function ThinkingBlock({
  thinking,
  active = false,
  messageId,
  blockIndex,
  durationMs
}) {
  const [isOpen, setIsOpen] = useState(active)
  // null 表示耗时未知（如重启后加载的旧消息无 durationMs），标题不应伪造 0s
  const [elapsed, setElapsed] = useState<number | null>(null)
  const startTimeRef = useRef<number | null>(null)
  const userToggledRef = useRef(false)
  const prevActiveRef = useRef(active)
  const viewportRef = useRef<HTMLDivElement>(null)
  const displayThinking = useMemo(
    () => normalizeThinkingForDisplay(thinking),
    [thinking]
  )

  // 与流式边界对齐：active 时确保 memory 已开工；结束时收口
  useEffect(() => {
    if (messageId === undefined || blockIndex === undefined) return
    if (active) {
      markThinkingStarted(messageId, blockIndex)
    } else {
      markThinkingEndedForMessage(messageId)
    }
  }, [active, messageId, blockIndex])

  // 本地计时兜底（无 messageId / durationMs 的单测路径）
  useEffect(() => {
    if (active) {
      if (startTimeRef.current === null) {
        startTimeRef.current = Date.now()
      }
      const timer = setInterval(() => {
        const delta = (Date.now() - (startTimeRef.current ?? Date.now())) / 1000
        setElapsed(Math.round(delta * 10) / 10)
      }, 100)
      return () => clearInterval(timer)
    }

    if (startTimeRef.current !== null) {
      const finalDelta = (Date.now() - startTimeRef.current) / 1000
      setElapsed(Math.round(finalDelta * 10) / 10)
      startTimeRef.current = null
    }
  }, [active])

  // 展开策略：进行中自动展开；结束自动收起（未手动操作时）
  useEffect(() => {
    const wasActive = prevActiveRef.current
    prevActiveRef.current = active

    if (userToggledRef.current) return

    if (active) {
      setIsOpen(true)
    } else if (wasActive && !active) {
      setIsOpen(false)
    }
  }, [active])

  // 思考进行中且展开时，把视窗钉到底部，让最新内容入屏
  useEffect(() => {
    if (!active || !isOpen) return
    const el = viewportRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [displayThinking, active, isOpen])

  if (!thinking) return null

  const displayElapsed = resolveDisplayElapsedSec({
    durationMs,
    messageId,
    blockIndex,
    localElapsed: elapsed
  })

  const headerTitle = active
    ? 'Thinking…'
    : displayElapsed !== null
      ? `Thought for ${formatElapsed(displayElapsed)}`
      : 'Thought'

  return (
    <div className={`thinking-block ${active ? 'thinking-block--active' : ''}`}>
      <button
        type="button"
        className="thinking-block__summary"
        aria-expanded={isOpen}
        onClick={() => {
          userToggledRef.current = true
          setIsOpen(v => !v)
        }}
      >
        <span
          className={`thinking-block__title ${active ? 'thinking-block__title--shimmer' : ''}`}
        >
          {headerTitle}
        </span>
        <ChevronIcon
          size={12}
          direction={isOpen ? 'down' : 'right'}
          className="thinking-block__arrow"
        />
      </button>
      <div
        className={`thinking-block__collapsible ${isOpen ? '' : 'thinking-block__collapsible--collapsed'}`}
      >
        <div className="thinking-block__content">
          <div className="thinking-block__markdown" ref={viewportRef}>
            <MarkdownRenderer content={displayThinking} isStreaming={active} chunkFade />
          </div>
        </div>
      </div>
    </div>
  )
})
