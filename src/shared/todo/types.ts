/**
 * Todo 数据模型
 *
 * 任务列表由模型通过 todo_write 工具维护，会话级持久化，独立于对话历史。
 * 字段极简：内容、状态、优先级；写多复杂都救不了模型，反而是字段越少、语义越硬越好。
 */

/** Todo 状态机：pending → in_progress → completed / cancelled */
export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled'

/** 优先级：影响 UI 排序与展示权重 */
export type TodoPriority = 'high' | 'medium' | 'low'

/** Todo 单项：模型唯一可写入的数据形状 */
export interface TodoItem {
  content: string
  status: TodoStatus
  priority: TodoPriority
}

/** Todo 单项 + 紧凑视图标记（changed 行在前端高亮） */
export type TodoViewItem = TodoItem & { changed?: boolean }

/** 紧凑视图结果：full 模式全量渲染；compact 模式只渲染变更窗口 */
export interface TodoViewInfo {
  mode: 'full' | 'compact'
  todos: TodoViewItem[]
  /** 窗口之前被折叠的项数 */
  hiddenBefore: number
  /** 窗口之后被折叠的项数 */
  hiddenAfter: number
  /** 本次变化命中的项数（full 模式下也填充，便于上层判断） */
  changed: number
}

/** 允许的 status 字符串集合，用于 normalize 兜底 */
export const TODO_STATUSES: readonly TodoStatus[] = ['pending', 'in_progress', 'completed', 'cancelled']

/** 允许的 priority 字符串集合 */
export const TODO_PRIORITIES: readonly TodoPriority[] = ['high', 'medium', 'low']
