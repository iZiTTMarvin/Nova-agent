/**
 * TodoToolCard — Roadmap 冒泡块
 *
 * 不进 L3 脏活行：带「Todos · n/m」标题与状态图标。
 * 可折叠，默认展开，保证执行路线图可感知。
 *
 * 重渲染隔离：React.memo + args 引用比较。
 */
import React, { useEffect, useRef, useState } from 'react'
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

function TodoStatusGlyph({ status }: { status: TodoStatus }) {
  switch (status) {
    case 'completed':
      return (
        <span className="todo-tool-card__glyph todo-tool-card__glyph--completed" aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <circle cx="7" cy="7" r="6" fill="currentColor" />
            <path d="M4.2 7l1.8 1.8 3.8-3.8" stroke="#fff" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      )
    case 'in_progress':
      return (
        <span className="todo-tool-card__glyph todo-tool-card__glyph--in-progress" aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <circle cx="7" cy="7" r="5.25" stroke="currentColor" strokeWidth="1.75" />
            <circle cx="7" cy="7" r="2" fill="currentColor" />
          </svg>
        </span>
      )
    case 'cancelled':
      return (
        <span className="todo-tool-card__glyph todo-tool-card__glyph--cancelled" aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <circle cx="7" cy="7" r="5.25" stroke="currentColor" strokeWidth="1.4" />
            <path d="M4.5 4.5l5 5M9.5 4.5l-5 5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          </svg>
        </span>
      )
    case 'pending':
    default:
      return (
        <span className="todo-tool-card__glyph todo-tool-card__glyph--pending" aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <circle cx="7" cy="7" r="5.25" stroke="currentColor" strokeWidth="1.4" strokeDasharray="2.5 2" />
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
  return (
    <li className={`todo-tool-card__row todo-tool-card__row--${todo.status}`} data-status={todo.status}>
      <TodoStatusGlyph status={todo.status} />
      <TodoContentText content={todo.content} />
    </li>
  )
}

function areTodoPropsEqual(prev: TodoToolCardProps, next: TodoToolCardProps): boolean {
  return (
    prev.toolCallId === next.toolCallId &&
    prev.status === next.status &&
    prev.isLiveStreaming === next.isLiveStreaming &&
    prev.args === next.args
  )
}

export const TodoToolCard: React.FC<TodoToolCardProps> = React.memo(function TodoToolCard({
  args,
  status,
  isLiveStreaming = false
}) {
  // 进行中默认展开；轮次结束后自动收起（未手动操作时），避免历史消息占满视口
  const [isOpen, setIsOpen] = useState(isLiveStreaming)
  const userToggledRef = useRef(false)

  useEffect(() => {
    if (userToggledRef.current) return
    setIsOpen(isLiveStreaming)
  }, [isLiveStreaming])

  const todos = parseTodoSnapshot(args)
  const { completed, total } = countTodoProgress(todos)

  const rootClass = [
    'todo-tool-card',
    isLiveStreaming ? 'todo-tool-card--live' : '',
    status === 'error' ? 'todo-tool-card--error' : '',
    status === 'running' ? 'todo-tool-card--running' : '',
    isOpen ? 'todo-tool-card--open' : 'todo-tool-card--collapsed'
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div className={rootClass} role="region" aria-label="任务列表">
      <button
        type="button"
        className="todo-tool-card__header"
        onClick={() => {
          userToggledRef.current = true
          setIsOpen(prev => !prev)
        }}
        aria-expanded={isOpen}
      >
        <span className="todo-tool-card__label">Todos</span>
        <span className="todo-tool-card__progress">
          {total > 0 ? `${completed}/${total}` : '0/0'}
        </span>
        <ChevronIcon
          size={12}
          direction={isOpen ? 'down' : 'right'}
          className="todo-tool-card__chevron"
        />
      </button>
      {isOpen && (
        total === 0 ? (
          <div className="todo-tool-card__empty">暂无任务</div>
        ) : (
          <ul className="todo-tool-card__list">
            {todos.map((todo, idx) => (
              <TodoListRow key={`${idx}-${todo.content}`} todo={todo} />
            ))}
          </ul>
        )
      )}
    </div>
  )
}, areTodoPropsEqual)
