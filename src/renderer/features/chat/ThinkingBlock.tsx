/**
 * ThinkingBlock — 「思考」轻量单行折叠行
 *
 * 运行中保持单行在行内流式吐字（不展开大卡片），结束后只显示耗时摘要；
 * 用户点击整行或箭头时展开完整 Markdown 思考内容。
 */
import React, { useState, useEffect, useMemo, useRef } from 'react'
import { ChevronIcon, ThinkIcon } from '../../components/Icons'
import { useScrollFadeMask } from '../../hooks/useScrollFadeMask'
import { MarkdownRenderer } from './MarkdownRenderer'
import { TurnProcessCollapsible } from './TurnProcessCollapsible'
import {
  markThinkingEnded,
  markThinkingStarted,
  readThinkingElapsedSec
} from '../../lib/thinkingTimingMemory'
import { normalizeThinkingForDisplay } from './turnProcessModel'
import { formatDurationMs } from './turnSummaryDisplay'
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
  if (seconds >= 60) return formatDurationMs(seconds * 1000)
  return `${Math.max(1, Math.round(seconds))} 秒`
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
  const headerRef = useRef<HTMLButtonElement>(null)
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

  // 展开状态下将完整 Markdown 内容钉在底部（流式追加时）
  useEffect(() => {
    if (!isOpen) return
    const el = viewportRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [displayThinking, isOpen])

  useScrollFadeMask(viewportRef, { enabled: isOpen, fadeSize: 18 })

  if (!thinking) return null

  const displayElapsed = resolveDisplayElapsedSec({
    durationMs,
    messageId,
    blockIndex,
    localElapsed: elapsed
  })

  // 进行中流式展示最新一行；结束后只给耗时，原文点开再看（缺耗时的旧消息退回首行）
  const title = active ? '思考中' : '已思考'
  const summaryText = active
    ? latestLine(displayThinking)
    : displayElapsed !== null
      ? formatElapsed(displayElapsed)
      : firstLine(displayThinking)

  return (
    <div className={`thinking-block ${active ? 'thinking-block--active' : ''} ${isOpen ? 'thinking-block--open' : ''}`}>
      <button
        ref={headerRef}
        type="button"
        className="thinking-block__summary"
        aria-expanded={isOpen}
        onClick={() => setIsOpen(v => !v)}
      >
        <span className="thinking-block__icon-slot" aria-hidden="true">
          <ThinkIcon size={12} className="thinking-block__icon" />
        </span>
        <span className="thinking-block__title">
          {title}
        </span>
        <span
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

      <TurnProcessCollapsible
        open={isOpen}
        pinHeaderRef={headerRef}
        className="thinking-block__collapsible-shell"
      >
        <div className="thinking-block__collapsible">
          <div className="thinking-block__content">
            <div className="thinking-block__markdown scroll-fade-y" ref={viewportRef}>
              <MarkdownRenderer content={displayThinking} isStreaming={active} chunkFade />
            </div>
          </div>
        </div>
      </TurnProcessCollapsible>
    </div>
  )
})
