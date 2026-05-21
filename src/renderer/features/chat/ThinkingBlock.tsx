import React, { useState, useEffect } from 'react'
import { ChevronIcon } from '../../components/Icons'
import './ThinkingBlock.css'

interface ThinkingBlockProps {
  thinking: string
  active?: boolean // 是否正在进行流式输出（思考中）
}

export const ThinkingBlock: React.FC<ThinkingBlockProps> = ({ thinking, active = false }) => {
  const [isOpen, setIsOpen] = useState(true) // 默认展开，便于看到正在流式输入的内容
  const [seconds, setSeconds] = useState(0)

  // 正在思考时，每秒更新计时器
  useEffect(() => {
    let timer: NodeJS.Timeout
    if (active) {
      setIsOpen(true) // 激活状态时强制展开
      timer = setInterval(() => {
        setSeconds((prev) => prev + 1)
      }, 1000)
    }
    return () => {
      if (timer) clearInterval(timer)
    }
  }, [active])

  // 当思考结束（active 变为 false）时，如果是自动展开的，为了不占空间可以自动折叠起来
  useEffect(() => {
    if (!active && thinking) {
      // 延迟一小段时间再折叠，提供平滑的心智切换
      const timeout = setTimeout(() => {
        setIsOpen(false)
      }, 1200)
      return () => clearTimeout(timeout)
    }
  }, [active])

  if (!thinking) return null

  // 格式化标题文字
  const getHeaderTitle = () => {
    if (active) {
      return `正在思考中... (${seconds}秒)`
    }
    return seconds > 0 ? `已思考 ${seconds} 秒` : '思考过程'
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
}
