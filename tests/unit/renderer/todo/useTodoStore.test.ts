/**
 * useTodoStore 单元测试
 *
 * 覆盖场景：
 * - applyUpdate 写入与按 sessionId 隔离
 * - 进度统计（completed/total）正确
 * - 切换 sessionId 时不串数据
 * - setSessionTodos 用于从持久化恢复
 * - selectSessionTodoState selector 行为
 */
import { describe, expect, it, beforeEach } from 'vitest'
import { useTodoStore, selectSessionTodoState, selectVisibleTodoItems, type TodoUpdate } from '../../../../src/renderer/features/todo/useTodoStore'
import type { TodoItem, TodoViewInfo } from '../../../../src/shared/todo/types'

function makeUpdate(sessionId: string, todos: TodoItem[], view: TodoViewInfo = { mode: 'full', todos, hiddenBefore: 0, hiddenAfter: 0, changed: 0 }): TodoUpdate {
  return { sessionId, todos, view }
}

describe('useTodoStore', () => {
  beforeEach(() => {
    useTodoStore.getState().reset()
  })

  it('applyUpdate 写入并按 sessionId 隔离', () => {
    useTodoStore.getState().applyUpdate(makeUpdate('sess_a', [
      { content: 'A1', status: 'pending', priority: 'medium' }
    ]))

    const aState = selectSessionTodoState(useTodoStore.getState(), 'sess_a')
    const bState = selectSessionTodoState(useTodoStore.getState(), 'sess_b')
    expect(aState).not.toBeNull()
    expect(bState).toBeNull()
    expect(aState!.total).toBe(1)
  })

  it('进度统计：completed + cancelled 计入 done', () => {
    useTodoStore.getState().applyUpdate(makeUpdate('sess_x', [
      { content: 'A', status: 'completed', priority: 'high' },
      { content: 'B', status: 'in_progress', priority: 'medium' },
      { content: 'C', status: 'pending', priority: 'low' },
      { content: 'D', status: 'cancelled', priority: 'low' }
    ]))

    const state = selectSessionTodoState(useTodoStore.getState(), 'sess_x')!
    expect(state.total).toBe(4)
    expect(state.completed).toBe(2) // completed + cancelled
  })

  it('view 透传：compact 模式下的窗口、changed 都来自后端', () => {
    const view: TodoViewInfo = {
      mode: 'compact',
      todos: [
        { content: 'A', status: 'in_progress', priority: 'high', changed: true }
      ],
      hiddenBefore: 2,
      hiddenAfter: 3,
      changed: 1
    }
    useTodoStore.getState().applyUpdate(makeUpdate('sess_c', [
      { content: 'A', status: 'in_progress', priority: 'high' }
    ], view))

    const state = selectSessionTodoState(useTodoStore.getState(), 'sess_c')!
    expect(state.view.mode).toBe('compact')
    expect(state.view.hiddenBefore).toBe(2)
    expect(state.view.hiddenAfter).toBe(3)
    expect(state.view.todos[0].changed).toBe(true)
  })

  it('selectSessionTodoState：null sessionId 返回 null', () => {
    expect(selectSessionTodoState(useTodoStore.getState(), null)).toBeNull()
  })

  it('selectVisibleTodoItems：state 为 null 时返回空数组', () => {
    expect(selectVisibleTodoItems(null)).toEqual([])
  })

  it('setSessionTodos 用于 selectSession 路径从持久化恢复', () => {
    useTodoStore.getState().setSessionTodos('sess_z', [
      { content: 'A', status: 'pending', priority: 'medium' }
    ])
    const state = selectSessionTodoState(useTodoStore.getState(), 'sess_z')
    expect(state).not.toBeNull()
    expect(state!.todos).toHaveLength(1)
  })

  it('多个会话独立计数，applyUpdate 不影响其他会话', () => {
    useTodoStore.getState().applyUpdate(makeUpdate('sess_a', [
      { content: 'A1', status: 'completed', priority: 'medium' }
    ]))
    useTodoStore.getState().applyUpdate(makeUpdate('sess_b', [
      { content: 'B1', status: 'pending', priority: 'medium' },
      { content: 'B2', status: 'pending', priority: 'medium' }
    ]))

    const a = selectSessionTodoState(useTodoStore.getState(), 'sess_a')!
    const b = selectSessionTodoState(useTodoStore.getState(), 'sess_b')!
    expect(a.total).toBe(1)
    expect(a.completed).toBe(1)
    expect(b.total).toBe(2)
    expect(b.completed).toBe(0)
  })
})
