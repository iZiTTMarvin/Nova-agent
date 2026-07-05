/**
 * ThinkingBlock — Cursor 风「Thought for Xs」轻量折叠行
 *
 * 无边框卡片壳；进行中默认展开，结束后自动收起（用户手动点过则尊重其选择）。
 */
import React, { useState, useEffect, useRef } from 'react'
import { ChevronIcon } from '../../components/Icons'
import './ThinkingBlock.css'

interface ThinkingBlockProps {
  thinking: string
  active?: boolean
}

function formatElapsed(seconds: number): string {
  if (seconds < 10) return `${seconds.toFixed(1)}s`
  return `${Math.round(seconds)}s`
}

export const ThinkingBlock: React.FC<ThinkingBlockProps> = React.memo(function ThinkingBlock({
  thinking,
  active = false
}) {
  const [isOpen, setIsOpen] = useState(active)
  const [elapsed, setElapsed] = useState(0)
  const startTimeRef = useRef<number | null>(null)
  const userToggledRef = useRef(false)
  const prevActiveRef = useRef(active)

  // 计时：进行中每 100ms 刷新；结束时补算最终耗时
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

  if (!thinking) return null

  const getHeaderTitle = () => {
    if (active) {
      return `Thinking… ${formatElapsed(elapsed)}`
    }
    return elapsed > 0 ? `Thought for ${formatElapsed(elapsed)}` : 'Thought'
  }

  return (
    <details
      className={`thinking-block ${active ? 'thinking-block--active' : ''}`}
      open={isOpen}
      onToggle={(e) => {
        userToggledRef.current = true
        setIsOpen((e.target as HTMLDetailsElement).open)
      }}
    >
      <summary className="thinking-block__summary">
        <div className="thinking-block__header-content">
          <span className="thinking-block__title">{getHeaderTitle()}</span>
          <ChevronIcon
            size={12}
            direction={isOpen ? 'down' : 'right'}
            className="thinking-block__arrow"
          />
        </div>
      </summary>
      {isOpen && (
        <div className="thinking-block__content">
          <pre className="thinking-block__pre">
            <code>{thinking}</code>
          </pre>
        </div>
      )}
    </details>
  )
})
