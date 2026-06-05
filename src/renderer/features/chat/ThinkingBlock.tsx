import React, { useState, useEffect, useRef } from 'react'
import { ChevronIcon } from '../../components/Icons'
import './ThinkingBlock.css'

interface ThinkingBlockProps {
  thinking: string
  active?: boolean // 是否正在进行流式输出（思考中）
}

export const ThinkingBlock: React.FC<ThinkingBlockProps> = React.memo(function ThinkingBlock({ thinking, active = false }) {
  // 正在思考的块默认展开；历史完成块默认折叠，避免打开旧会话时撑开整屏。
  const [isOpen, setIsOpen] = useState(active)
  // 使用 Date.now() 差值计算真实经过时间，避免主线程卡顿时计时器"停顿再追赶"
  const [elapsed, setElapsed] = useState(0)
  const startTimeRef = useRef<number | null>(null)

  // 正在思考时，每 100ms 更新计时器（基于真实时间差值，精度到 0.1 秒）
  useEffect(() => {
    if (active) {
      setIsOpen(true) // 激活状态时强制展开
      // 首次激活或重新激活时记录起始时间
      if (startTimeRef.current === null) {
        startTimeRef.current = Date.now()
      }
      const timer = setInterval(() => {
        const delta = (Date.now() - (startTimeRef.current ?? Date.now())) / 1000
        // 保留一位小数，消除浮点精度误差
        setElapsed(Math.round(delta * 10) / 10)
      }, 100)
      return () => clearInterval(timer)
    } else {
      // 思考结束：补算最终耗时后再清空起始时间
      // 确保即使 <100ms 或在两个 tick 之间结束，也能显示真实经过时间
      if (startTimeRef.current !== null) {
        const finalDelta = (Date.now() - startTimeRef.current) / 1000
        setElapsed(Math.round(finalDelta * 10) / 10)
        startTimeRef.current = null
      }
    }
  }, [active])

  if (!thinking) return null

  // 格式化标题文字
  const getHeaderTitle = () => {
    if (active) {
      return `正在思考中... (${elapsed.toFixed(1)}秒)`
    }
    return elapsed > 0 ? `已思考 ${elapsed.toFixed(1)} 秒` : '思考过程'
  }

  return (
    <details
      className={`thinking-block ${active ? 'thinking-block--active' : ''}`}
      open={isOpen}
      onToggle={(e) => {
        // 同步 details 原生的 open 状态到 React state，防止状态冲突
        setIsOpen((e.target as HTMLDetailsElement).open)
      }}
    >
      <summary className="thinking-block__summary">
        <div className="thinking-block__header-content">
          <div className={`thinking-block__status-indicator ${active ? 'thinking-block__status-indicator--pulsing' : ''}`} />
          <span className="thinking-block__title">{getHeaderTitle()}</span>
        </div>
        <ChevronIcon
          size={14}
          direction={isOpen ? 'up' : 'down'}
          className="thinking-block__arrow"
        />
      </summary>
      <div className="thinking-block__content">
        <pre className="thinking-block__pre">
          <code>{thinking}</code>
        </pre>
      </div>
    </details>
  )
})
