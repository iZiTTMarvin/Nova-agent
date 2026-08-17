/**
 * ThinkingBlock — 「Think · 摘要」轻量单行折叠行
 *
 * 运行中保持单行在行内流式吐字（不展开大卡片），结束后显示首行/耗时摘要；
 * 用户点击整行或箭头时展开完整 Markdown 思考内容。
 */
import React, { useState, useEffect, useMemo, useRef } from 'react'
import { ChevronIcon, ThinkIcon } from '../../components/Icons'
import { MarkdownRenderer } from './MarkdownRenderer'
import {
  markThinkingEnded,
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

function firstLine(text: string): string {
  const visible = text.trim()
  const newline = visible.indexOf('\n')
  return newline === -1 ? visible : visible.slice(0, newline).trim()
}

function latestLine(text: string): string {
  const visible = text.trimEnd()
  const newline = visible.lastIndexOf('\n')
  return newline === -1 ? visible : visible.slice(newline + 1).trimStart()
}

export const ThinkingBlock: React.FC<ThinkingBlockProps> = React.memo(function ThinkingBlock({
  thinking,
  active = false,
  messageId,
  blockIndex,
  durationMs
}) {
  const [isOpen, setIsOpen] = useState(false)
  const [elapsed, setElapsed] = useState<number | null>(null)
  const startTimeRef = useRef<number | null>(null)
  const summaryRef = useRef<HTMLSpanElement>(null)
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
      markThinkingEnded(messageId, blockIndex)
    }
  }, [active, messageId, blockIndex])

  // 本地计时兜底
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

  // 运行中单行文本自动横向跟随最新流式字
  useEffect(() => {
    if (!active) return
    const el = summaryRef.current
    if (el) {
      el.scrollLeft = el.scrollWidth - el.clientWidth
    }
  }, [displayThinking, active])

  // 展开状态下将完整 Markdown 内容钉在底部（流式追加时）
  useEffect(() => {
    if (!isOpen) return
    const el = viewportRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [displayThinking, isOpen])

  if (!thinking) return null

  const displayElapsed = resolveDisplayElapsedSec({
    durationMs,
    messageId,
    blockIndex,
    localElapsed: elapsed
  })

  // 单行摘要文本：流式运行中取最新一行；完成后取首行/总览
  const summaryText = active
    ? latestLine(displayThinking) || 'Thinking…'
    : firstLine(displayThinking) || (displayElapsed !== null ? `Thought for ${formatElapsed(displayElapsed)}` : 'Thought')

  return (
    <div className={`thinking-block ${active ? 'thinking-block--active' : ''} ${isOpen ? 'thinking-block--open' : ''}`}>
      <button
        type="button"
        className="thinking-block__summary"
        aria-expanded={isOpen}
        onClick={() => setIsOpen(v => !v)}
      >
        <ThinkIcon size={14} className="thinking-block__icon" />
        <span className="thinking-block__title">
          Think
        </span>
        <span className="thinking-block__sep" aria-hidden="true">·</span>
        <span
          ref={summaryRef}
          className={`thinking-block__line-text ${active ? 'thinking-block__line-text--active' : ''}`}
        >
          {summaryText}
        </span>
        <ChevronIcon
          size={12}
          direction={isOpen ? 'down' : 'right'}
          className="thinking-block__arrow"
        />
      </button>

      {isOpen && (
        <div className="thinking-block__collapsible">
          <div className="thinking-block__content">
            <div className="thinking-block__markdown" ref={viewportRef}>
              <MarkdownRenderer content={displayThinking} isStreaming={active} chunkFade />
            </div>
          </div>
        </div>
      )}
    </div>
  )
})
