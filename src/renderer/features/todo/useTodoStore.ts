/**
 * TodoPanel 渲染端 store
 *
 * 职责：
 * - 订阅 IPC `agent:todos-updated` 事件，把后端推送的最新 todo 列表与紧凑视图缓存到本地
 * - 按 sessionId 隔离：切换会话时显示对应会话的 todo（不串数据）
 * - 暴露给 TodoPanel 组件消费的 selector：当前会话的 todos / view / 进度统计
 *
 * 设计要点：
 * - 使用 zustand 局部 store（与 useAppStore 平级，但不混入消息状态）
 * - view 由后端计算并随事件下发，前端不做二次计算
 * - 会话切换时不主动拉取 todo（todo 是 session 的元数据，未来如需补齐可在 selectSession 里主动拉一次）
 */
import { create } from 'zustand'
import type { TodoItem, TodoViewInfo, TodoViewItem } from '../../../shared/todo/types'

export interface TodoUpdate {
  sessionId: string
  todos: TodoItem[]
  view: TodoViewInfo
}

interface TodoStoreState {
  /**
   * 按 sessionId 缓存的最新 todo 状态。
   * 包含：完整 todos、当前 view、进度（已完成 / 总数）、最近一次更新时间。
   */
  bySession: Record<string, TodoSessionState>
  /** 当前 store 已通过 applyUpdate 收到过的会话 ID 集合，便于上层做"是否有数据"判断 */
  seen: Record<string, true>
}

export interface TodoSessionState {
  todos: TodoItem[]
  view: TodoViewInfo
  completed: number
  total: number
  /** 最近一次更新时的 epoch ms（用于"刚刚更新"动画/排序） */
  updatedAt: number
  /** 本轮是否已收到 todo_write；dock 显示门控，防止新轮秒弹上一轮残留 */
  turnTouched: boolean
}

interface TodoStoreActions {
  /** 处理来自 main 进程的 todos_updated 事件 */
  applyUpdate: (update: TodoUpdate) => void
  /** 切换会话：清空当前展示的指针（不主动清缓存，缓存按 sessionId 隔离保留） */
  reset: () => void
  /** 主动设置某会话的 todo 状态（用于 selectSession 时从持久化恢复） */
  setSessionTodos: (sessionId: string, todos: TodoItem[]) => void
  /** 新轮发起时清零 turnTouched；会话尚无 state 时 no-op */
  resetTurnTouched: (sessionId: string) => void
}

function summarize(todos: TodoItem[]): { completed: number; total: number } {
  let completed = 0
  for (const t of todos) {
    if (t.status === 'completed' || t.status === 'cancelled') completed++
  }
  return { completed, total: todos.length }
}

const EMPTY_VIEW: TodoViewInfo = { mode: 'full', todos: [], hiddenBefore: 0, hiddenAfter: 0, changed: 0 }

export const useTodoStore = create<TodoStoreState & TodoStoreActions>((set) => ({
  bySession: {},
  seen: {},

  applyUpdate: (update) => {
    const { sessionId, todos, view } = update
    const { completed, total } = summarize(todos)
    set((state) => ({
      bySession: {
        ...state.bySession,
        [sessionId]: { todos, view, completed, total, updatedAt: Date.now(), turnTouched: true }
      },
      seen: { ...state.seen, [sessionId]: true }
    }))
  },

  setSessionTodos: (sessionId, todos) => {
    const { completed, total } = summarize(todos)
    set((state) => ({
      bySession: {
        ...state.bySession,
        // 从持久化恢复的数据视为已知，直接可显示
        [sessionId]: { todos, view: EMPTY_VIEW, completed, total, updatedAt: Date.now(), turnTouched: true }
      },
      seen: { ...state.seen, [sessionId]: true }
    }))
  },

  resetTurnTouched: (sessionId) => {
    set((state) => {
      const existing = state.bySession[sessionId]
      if (!existing) return state
      return {
        bySession: {
          ...state.bySession,
          [sessionId]: { ...existing, turnTouched: false }
        }
      }
    })
  },

  reset: () => {
    set({ bySession: {}, seen: {} })
  }
}))

/** 选中某会话的 todo 状态（不存在时返回 null，UI 据此决定是否渲染） */
export function selectSessionTodoState(
  state: TodoStoreState,
  sessionId: string | null
): TodoSessionState | null {
  if (!sessionId) return null
  return state.bySession[sessionId] ?? null
}

/** 提取 view 渲染用的 todos（compact/full 都已经过服务端计算，这里只是别名） */
export function selectVisibleTodoItems(state: TodoSessionState | null): TodoViewItem[] {
  if (!state) return []
  return state.view.todos
}
