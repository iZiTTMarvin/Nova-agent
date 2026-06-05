/**
 * TodoItemRow — 单行 todo 渲染
 *
 * 视觉规约：
 * - 状态图标：[ ] pending / [~] in_progress / [x] completed / [-] cancelled
 * - in_progress 行整行高亮（淡色背景）
 * - completed/cancelled 行内容划线
 * - 优先级用小色块（chip）表示：高=红/中=黄/低=灰
 */
import React from 'react'
import type { TodoItem, TodoPriority, TodoStatus, TodoViewItem } from '../../../shared/todo/types'

interface TodoItemRowProps {
  todo: TodoViewItem
  /** 是否是当前 changed 行（compact 模式下高亮） */
  changed?: boolean
}

const STATUS_GLYPH: Record<TodoStatus, string> = {
  pending: '[ ]',
  in_progress: '[~]',
  completed: '[x]',
  cancelled: '[-]'
}

const PRIORITY_CHIP: Record<TodoPriority, { label: string; className: string }> = {
  high: { label: '高', className: 'todo-priority todo-priority--high' },
  medium: { label: '中', className: 'todo-priority todo-priority--medium' },
  low: { label: '低', className: 'todo-priority todo-priority--low' }
}

function rowClass(todo: TodoItem, changed?: boolean): string {
  const classes = ['todo-row']
  if (todo.status === 'in_progress') classes.push('todo-row--in-progress')
  if (todo.status === 'completed' || todo.status === 'cancelled') classes.push('todo-row--done')
  if (changed) classes.push('todo-row--changed')
  return classes.join(' ')
}

export const TodoItemRow: React.FC<TodoItemRowProps> = ({ todo, changed }) => {
  const glyph = STATUS_GLYPH[todo.status] ?? '[ ]'
  const chip = PRIORITY_CHIP[todo.priority] ?? PRIORITY_CHIP.medium

  return (
    <div className={rowClass(todo, changed)} data-status={todo.status}>
      <span className="todo-row__glyph" aria-label={`状态: ${todo.status}`}>{glyph}</span>
      <span className="todo-row__content">{todo.content}</span>
      <span className={chip.className} title={`优先级: ${todo.priority}`}>{chip.label}</span>
    </div>
  )
}
