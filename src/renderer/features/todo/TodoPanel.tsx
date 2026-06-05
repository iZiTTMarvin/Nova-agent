/**
 * TodoPanel — 当前会话的 todo 列表渲染
 *
 * 挂载点：ChatPanel 头部下方（替代"TaskHeader"概念，nova 没有独立 TaskHeader 组件）。
 * 行为：
 * - compact 模式：显示折叠信息 "... 隐藏 N 项 / 显示 X-Y / 隐藏 M 项 ..."，仅渲染变更窗口
 * - full 模式：完整展示所有 todo
 * - 整体可折叠：点击 header 切换展开/收起
 * - 进度 chip：显示"已完成 N / 总 M"
 *
 * 注意：仅在 todo 数据存在（total > 0）时挂载；空态不占视觉空间。
 */
import React, { useMemo, useState } from 'react'
import { useTodoStore, selectSessionTodoState } from './useTodoStore'
import { TodoItemRow } from './TodoItemRow'
import type { TodoViewItem } from '../../../shared/todo/types'

interface TodoPanelProps {
  sessionId: string | null
}

interface RangeLineProps {
  hiddenBefore: number
  shownStart: number
  shownEnd: number
  shownCount: number
  hiddenAfter: number
  total: number
}

/** compact 模式下的折叠信息行 "... 隐藏 N 项 · 显示 X-Y 共 K · 隐藏 M 项" */
const CompactRangeLine: React.FC<RangeLineProps> = ({
  hiddenBefore,
  shownStart,
  shownEnd,
  shownCount,
  hiddenAfter,
  total
}) => {
  if (hiddenBefore === 0 && hiddenAfter === 0) return null
  return (
    <div className="todo-panel__range">
      {hiddenBefore > 0 && <span>… 隐藏 {hiddenBefore} 项</span>}
      <span>
        显示 {shownStart}-{shownEnd}（共 {shownCount} 项 / 总 {total}）
      </span>
      {hiddenAfter > 0 && <span>隐藏 {hiddenAfter} 项 …</span>}
    </div>
  )
}

export const TodoPanel: React.FC<TodoPanelProps> = ({ sessionId }) => {
  const sessionState = useTodoStore(state => selectSessionTodoState(state, sessionId))
  const [collapsed, setCollapsed] = useState(false)

  const visibleItems: TodoViewItem[] = useMemo(
    () => sessionState?.view.todos ?? [],
    [sessionState?.view.todos]
  )

  if (!sessionState || sessionState.total === 0) {
    return null
  }

  const { view, completed, total } = sessionState
  const isCompact = view.mode === 'compact'
  const shownStart = view.hiddenBefore + 1
  const shownEnd = view.hiddenBefore + visibleItems.length

  return (
    <div className="todo-panel" data-mode={view.mode}>
      <button
        type="button"
        className="todo-panel__header"
        onClick={() => setCollapsed(prev => !prev)}
        aria-expanded={!collapsed}
      >
        <span className="todo-panel__caret" data-collapsed={collapsed} aria-hidden="true">▾</span>
        <span className="todo-panel__title">当前计划</span>
        <span className="todo-panel__progress" aria-label={`已完成 ${completed} 项，共 ${total} 项`}>
          {completed}/{total}
        </span>
      </button>

      {!collapsed && (
        <div className="todo-panel__body">
          {isCompact && (
            <CompactRangeLine
              hiddenBefore={view.hiddenBefore}
              shownStart={shownStart}
              shownEnd={shownEnd}
              shownCount={visibleItems.length}
              hiddenAfter={view.hiddenAfter}
              total={total}
            />
          )}
          <div className="todo-panel__items">
            {visibleItems.map((todo, idx) => (
              <TodoItemRow
                // 用全局索引（hiddenBefore + 局部 idx）作为 key：
                // compact 模式窗口滑动时，同一条 todo 的 key 保持不变，
                // 避免 React 错误地销毁/重建 DOM，保留 todo-changed-flash 动画。
                // 不用 todo.content 是因为 content 可能被模型改写，key 变化同样会触发重建。
                // 全量替换时整个列表重建，key 会自然重新分配。
                key={`todo-${view.hiddenBefore + idx}`}
                todo={todo}
                changed={Boolean(todo.changed)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
