/**
 * Todo 入参归一化（runtime todo_write 与 renderer 快照解析共用）
 *
 * 防御性处理：缺失字段补默认值、空 content 丢弃、非法 status/priority 降级。
 */
import type { TodoItem, TodoStatus, TodoPriority } from './types'
import { TODO_STATUSES, TODO_PRIORITIES } from './types'

/**
 * 把模型传入的 todos 数组做防御性归一化。
 * 优先降级而不是抛错，避免 AgentLoop 主循环因脏数据卡住。
 */
export function normalizeTodos(input: unknown): TodoItem[] {
  if (!Array.isArray(input)) {
    return []
  }

  const result: TodoItem[] = []
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue
    const obj = raw as Record<string, unknown>

    const content = typeof obj.content === 'string' ? obj.content.trim() : ''
    if (!content) {
      // 空 content 直接丢弃；模型把空串塞进来常见于"先占位再补"的草稿状态
      continue
    }

    const status: TodoStatus = TODO_STATUSES.includes(obj.status as TodoStatus)
      ? (obj.status as TodoStatus)
      : 'pending'

    const priority: TodoPriority = TODO_PRIORITIES.includes(obj.priority as TodoPriority)
      ? (obj.priority as TodoPriority)
      : 'medium'

    result.push({ content, status, priority })
  }
  return result
}
