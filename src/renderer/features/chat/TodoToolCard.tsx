/**
 * TodoToolCard — 消息流中 todo_write 专用快照卡片
 *
 * 只读当次 arguments.todos，不订阅 useTodoStore（与顶部 TodoPanel 双轨共存）。
 */
import React, { useState } from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import { ChevronIcon } from '../../components/Icons'
import { parseTodoSnapshot, countTodoProgress, splitTodoContentSegments } from './todoSnapshot'
import type { TodoItem, TodoStatus } from '../../../shared/todo/types'
import './TodoToolCard.css'

export interface TodoToolCardProps {
  toolCallId?: string
  args: Record<string, unknown>
  status: 'running' | 'success' | 'error'
  isLiveStreaming?: boolean
}

export const LIVE_ENTER_SPRING = { type: 'spring' as const, stiffness: 300, damping: 30, mass: 0.8 }
export const NO_ANIMATION = { duration: 0 }

function TodoStatusIcon({ status }: { status: TodoStatus }) {
  switch (status) {
    case 'completed':
      return (
        <span className="todo-tool-card__icon todo-tool-card__icon--completed" aria-hidden="true">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <circle cx="8" cy="8" r="7" fill="currentColor" />
            <path d="M5 8l2 2 4-4" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      )
    case 'in_progress':
      return (
        <span className="todo-tool-card__icon todo-tool-card__icon--in-progress" aria-hidden="true">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" />
          </svg>
        </span>
      )
    case 'cancelled':
      return (
        <span className="todo-tool-card__icon todo-tool-card__icon--cancelled" aria-hidden="true">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M5 5l6 6M11 5L5 11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </span>
      )
    case 'pending':
    default:
      return (
        <span className="todo-tool-card__icon todo-tool-card__icon--pending" aria-hidden="true">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" strokeDasharray="3 2" />
          </svg>
        </span>
      )
  }
}

function TodoContentText({ content }: { content: string }) {
  const segments = splitTodoContentSegments(content)
  return (
    <span className="todo-tool-card__text">
      {segments.map((seg, idx) =>
        seg.type === 'code' ? (
          <span key={idx} className="todo-tool-card__code">{seg.value}</span>
        ) : (
          <React.Fragment key={idx}>{seg.value}</React.Fragment>
        )
      )}
    </span>
  )
}

function TodoListRow({ todo }: { todo: TodoItem }) {
  const rowClass = [
    'todo-tool-card__row',
    todo.status === 'in_progress' ? 'todo-tool-card__row--in-progress' : '',
    todo.status === 'cancelled' ? 'todo-tool-card__row--cancelled' : '',
    todo.status === 'completed' ? 'todo-tool-card__row--completed' : ''
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <li className={rowClass} data-status={todo.status}>
      <TodoStatusIcon status={todo.status} />
      <TodoContentText content={todo.content} />
    </li>
  )
}

export const TodoToolCard: React.FC<TodoToolCardProps> = React.memo(function TodoToolCard({
  args,
  status,
  isLiveStreaming = false
}) {
  const todos = parseTodoSnapshot(args)
  const { completed, total } = countTodoProgress(todos)
  const prefersReducedMotion = useReducedMotion()
  const animateLive = isLiveStreaming && !prefersReducedMotion
  const defaultOpen = isLiveStreaming && status === 'running'
  const [isOpen, setIsOpen] = useState(defaultOpen)

  const headerLabel = total > 0 ? `${completed} / ${total} 项已完成` : '暂无任务'

  return (
    <motion.div
      initial={animateLive ? { scale: 0.98 } : false}
      animate={{ scale: 1 }}
      transition={animateLive ? LIVE_ENTER_SPRING : NO_ANIMATION}
      className={isLiveStreaming ? 'todo-tool-card todo-tool-card--live-enter' : 'todo-tool-card'}
    >
      <details
        className="todo-tool-card__details"
        open={isOpen}
        onToggle={(e) => setIsOpen((e.target as HTMLDetailsElement).open)}
      >
        <summary className="todo-tool-card__summary">
          <ChevronIcon size={14} direction={isOpen ? 'down' : 'right'} className="todo-tool-card__chevron" />
          <span className="todo-tool-card__header-label">{headerLabel}</span>
        </summary>
        {total > 0 && (
          <div className="todo-tool-card__body">
            <ul className="todo-tool-card__list">
              {todos.map((todo, idx) => (
                <TodoListRow key={`${idx}-${todo.content}`} todo={todo} />
              ))}
            </ul>
          </div>
        )}
      </details>
    </motion.div>
  )
})
