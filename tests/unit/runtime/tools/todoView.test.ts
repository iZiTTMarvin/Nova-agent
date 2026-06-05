/**
 * calculateTodoView 单元测试
 *
 * 用例覆盖 task 文档 1 中列出的全部场景：
 * - 首次创建 → full
 * - 中段状态变化 → compact + changed
 * - 全部终态 → full
 * - 内容改写 → full
 * - 追加新项 → full
 * - 列表清空 → full
 * - 状态变化但 content 相同 → compact
 */
import { describe, expect, it } from 'vitest'
import { calculateTodoView } from '../../../../src/runtime/tools/todoView'
import type { TodoItem } from '../../../../src/shared/todo/types'

function item(content: string, status: TodoItem['status'] = 'pending', priority: TodoItem['priority'] = 'medium'): TodoItem {
  return { content, status, priority }
}

describe('calculateTodoView', () => {
  it('首次创建：before 为空 → full 且无折叠', () => {
    const after = [item('Inspect files'), item('Implement fix'), item('Run checks')]
    const view = calculateTodoView([], after)

    expect(view.mode).toBe('full')
    expect(view.todos).toHaveLength(3)
    expect(view.hiddenBefore).toBe(0)
    expect(view.hiddenAfter).toBe(0)
  })

  it('中段一项标 completed → compact 命中变更行，前后各扩 1 行', () => {
    const before = Array.from({ length: 10 }, (_, i) => item(`Task ${i + 1}`))
    const after = before.map((todo, i) => (i === 4 ? { ...todo, status: 'completed' as const } : todo))

    const view = calculateTodoView(before, after)

    expect(view.mode).toBe('compact')
    expect(view.hiddenBefore).toBe(3)
    expect(view.hiddenAfter).toBe(4)
    expect(view.todos.map(t => t.content)).toEqual(['Task 4', 'Task 5', 'Task 6'])
    expect(view.todos.map(t => Boolean(t.changed))).toEqual([false, true, false])
  })

  it('全部进入终态 → full 模式', () => {
    const before = [item('A', 'completed'), item('B'), item('C')]
    const after = before.map(t => ({ ...t, status: 'completed' as const }))

    const view = calculateTodoView(before, after)

    expect(view.mode).toBe('full')
    expect(view.todos).toEqual(after)
  })

  it('内容被改写（非状态）→ full', () => {
    const before = [item('One'), item('Two'), item('Three'), item('Four')]
    const after = [item('One'), item('Two changed'), item('Three'), item('Four')]

    const view = calculateTodoView(before, after)

    expect(view.mode).toBe('full')
    expect(view.todos).toEqual(after)
  })

  it('追加新项 → full（结构性变化）', () => {
    const before = [item('One'), item('Two'), item('Three')]
    const after = [...before, item('Four')]

    const view = calculateTodoView(before, after)

    expect(view.mode).toBe('full')
    expect(view.todos).toHaveLength(4)
  })

  it('列表清空 → full + 空数组', () => {
    const before = [item('One'), item('Two')]
    const view = calculateTodoView(before, [])

    expect(view.mode).toBe('full')
    expect(view.todos).toEqual([])
    expect(view.hiddenBefore).toBe(0)
    expect(view.hiddenAfter).toBe(0)
  })

  it('状态变化但 content 相同 → compact（不视为结构性变化）', () => {
    const before = [item('A'), item('B'), item('C'), item('D'), item('E')]
    const after = before.map((t, i) => (i === 2 ? { ...t, status: 'in_progress' as const } : t))

    const view = calculateTodoView(before, after)

    expect(view.mode).toBe('compact')
    // 命中索引 2，前扩到 1，后扩到 3
    expect(view.todos.map(t => t.content)).toEqual(['B', 'C', 'D'])
    expect(view.todos.map(t => Boolean(t.changed))).toEqual([false, true, false])
  })

  it('区间正好覆盖整张表 → 退化为 full（hidden === 0）', () => {
    const before = [item('A'), item('B'), item('C')]
    // 命中首尾两个，窗口 [0,2] = 整张表
    const after = [
      { ...before[0], status: 'completed' as const },
      before[1],
      { ...before[2], status: 'in_progress' as const }
    ]

    const view = calculateTodoView(before, after)

    expect(view.mode).toBe('full')
    expect(view.todos).toHaveLength(3)
  })

  it('before 与 after 完全一致 → full（diff 为空）', () => {
    const list = [item('A'), item('B'), item('C')]

    const view = calculateTodoView(list, list.map(t => ({ ...t })))

    expect(view.mode).toBe('full')
    expect(view.changed).toBe(0)
  })

  it('全部 cancelled 视为终态 → full', () => {
    const before = [item('A', 'pending'), item('B', 'pending')]
    const after = [item('A', 'cancelled'), item('B', 'cancelled')]

    const view = calculateTodoView(before, after)

    expect(view.mode).toBe('full')
  })
})
