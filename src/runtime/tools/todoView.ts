/**
 * Todo 紧凑视图算法
 *
 * 移植自 kilocode TodoView.calculate（packages/opencode/src/kilocode/todo-view.ts）。
 * 目标：频繁小幅更新时让 UI 不要全量重绘，避免"todo 一变整列就跳"。
 *
 * 触发 full 模式（不需要算窗口）的条件：
 * 1. 首次创建（before 为空）
 * 2. 列表清空（after 为空）
 * 3. 结构性变化（长度不同 / 任意位置 content 被改写）
 * 4. 全部进入终态（completed / cancelled）
 * 5. diff 命中为空（before/after 实际没有差异）
 *
 * 其他场景：取 diff 区间的最小/最大索引，向前后各扩 1 行作为窗口。
 * 窗口覆盖整张表时也退化为 full（hidden === 0）。
 */
import type { TodoItem, TodoViewInfo, TodoViewItem } from '../../shared/todo/types'

/**
 * 计算 before → after 的紧凑视图。
 *
 * @param before 更新前的完整 todo 列表（首次写入时传 []）
 * @param after 更新后的完整 todo 列表（每次都是全量替换）
 */
export function calculateTodoView(before: TodoItem[], after: TodoItem[]): TodoViewInfo {
  const diff = after
    .map((todo, index) => ({
      index,
      changed: !isSameTodo(before[index], todo)
    }))
    .filter(item => item.changed)

  const wide =
    before.length === 0 ||
    after.length === 0 ||
    isStructuralChange(before, after) ||
    isAllTerminal(after) ||
    diff.length === 0
  if (wide) {
    return full(after, diff.length)
  }

  const firstChanged = Math.min(...diff.map(item => item.index))
  const lastChanged = Math.max(...diff.map(item => item.index))
  const first = Math.max(0, firstChanged - 1)
  const last = Math.min(after.length - 1, lastChanged + 1)
  const hidden = first + after.length - last - 1
  if (hidden === 0) {
    return full(after, diff.length)
  }

  const changedIndexes = new Set(diff.map(item => item.index))
  const todos: TodoViewItem[] = after.slice(first, last + 1).map((todo, offset) => ({
    ...todo,
    changed: changedIndexes.has(first + offset)
  }))

  return {
    mode: 'compact',
    todos,
    hiddenBefore: first,
    hiddenAfter: after.length - last - 1,
    changed: diff.length
  }
}

/** 全量渲染：所有项都参与展示，changed 字段不填（前端不强高亮） */
function full(after: TodoItem[], changed: number): TodoViewInfo {
  return {
    mode: 'full',
    todos: after.map(todo => ({ ...todo })),
    hiddenBefore: 0,
    hiddenAfter: 0,
    changed
  }
}

/** before[i] 与 after[i] 内容/状态/优先级完全一致才视为未变 */
function isSameTodo(before: TodoItem | undefined, after: TodoItem): boolean {
  if (!before) return false
  return (
    before.content === after.content &&
    before.status === after.status &&
    before.priority === after.priority
  )
}

/** 全部都是终态（completed / cancelled）时也算 wide：UI 全量展示"已完成 N 项" */
function isAllTerminal(todos: TodoItem[]): boolean {
  if (todos.length === 0) return false
  return todos.every(todo => todo.status === 'completed' || todo.status === 'cancelled')
}

/**
 * 结构性变化：长度不同，或者任意位置 content 改写。
 * 优先级/状态变化不算结构性变化（因为 UI 高亮就够了），只有"内容被重写"才触发全量。
 */
function isStructuralChange(before: TodoItem[], after: TodoItem[]): boolean {
  if (before.length !== after.length) return true
  for (let i = 0; i < after.length; i++) {
    if (before[i]?.content !== after[i].content) return true
  }
  return false
}
