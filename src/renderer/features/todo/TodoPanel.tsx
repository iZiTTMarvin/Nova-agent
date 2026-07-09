/**
 * TodoPanel — 当前会话计划 dock（composer 上方）
 *
 * 存在性：本轮已收到 todo_write（turnTouched）且列表非空。
 * 展开态：默认细条；todo 更新时展开 5s；优先 dock（askQuestion 等）强制细条。
 * idle 后细条保留，直到下一条消息清 turnTouched。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useTodoStore, selectSessionTodoState } from './useTodoStore'
import { TodoItemRow } from './TodoItemRow'
import type { TodoViewItem } from '../../../shared/todo/types'

interface TodoPanelProps {
  sessionId: string | null
  /** composer 上方已有更高优先级面板（askQuestion / compose askUser） */
  priorityDockOccupied?: boolean
}

/** todo 更新后自动展开，无新更新则收回细条 */
const AUTO_COLLAPSE_MS = 5000

interface RangeLineProps {
  hiddenBefore: number
  shownStart: number
  shownEnd: number
  shownCount: number
  hiddenAfter: number
  total: number
}

/** compact 模式下的折叠信息行 */
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

export const TodoPanel: React.FC<TodoPanelProps> = ({
  sessionId,
  priorityDockOccupied = false
}) => {
  const sessionState = useTodoStore(state => selectSessionTodoState(state, sessionId))
  const [expanded, setExpanded] = useState(false)
  const collapseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const priorityRef = useRef(priorityDockOccupied)
  priorityRef.current = priorityDockOccupied

  const hasTodos = (sessionState?.total ?? 0) > 0
  const turnTouched = sessionState?.turnTouched ?? false
  const updatedAt = sessionState?.updatedAt

  const clearCollapseTimer = () => {
    if (collapseTimerRef.current !== null) {
      clearTimeout(collapseTimerRef.current)
      collapseTimerRef.current = null
    }
  }

  const scheduleAutoCollapse = () => {
    clearCollapseTimer()
    collapseTimerRef.current = setTimeout(() => {
      collapseTimerRef.current = null
      setExpanded(false)
    }, AUTO_COLLAPSE_MS)
  }

  // 切会话：回到细条，清掉在途计时
  useEffect(() => {
    setExpanded(false)
    clearCollapseTimer()
  }, [sessionId])

  // 优先 dock 在场：强制细条
  useEffect(() => {
    if (priorityDockOccupied) {
      clearCollapseTimer()
      setExpanded(false)
    }
  }, [priorityDockOccupied])

  // todo 更新：自动展开并在 5s 后收回（优先 dock 期间跳过）
  useEffect(() => {
    if (updatedAt == null) return
    if (priorityRef.current) return
    setExpanded(true)
    scheduleAutoCollapse()
    return () => clearCollapseTimer()
  }, [updatedAt])

  // 卸载时清 timer
  useEffect(() => () => clearCollapseTimer(), [])

  const handleHeaderClick = () => {
    setExpanded(prev => {
      if (prev) {
        clearCollapseTimer()
        return false
      }
      // 手动展开：不启动自动收回，直到用户再收起或优先 dock
      return true
    })
  }

  const visibleItems: TodoViewItem[] = useMemo(
    () => sessionState?.view.todos ?? [],
    [sessionState?.view.todos]
  )

  const view = sessionState?.view
  const completed = sessionState?.completed ?? 0
  const total = sessionState?.total ?? 0
  const isCompact = view?.mode === 'compact'
  const shownStart = (view?.hiddenBefore ?? 0) + 1
  const shownEnd = (view?.hiddenBefore ?? 0) + visibleItems.length
  const shouldRender = !!(hasTodos && turnTouched && sessionState && view)

  return (
    <AnimatePresence>
      {shouldRender && (
        <motion.div
          key={`todo-dock-${sessionId}`}
          className="todo-dock"
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 16 }}
          transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
        >
          <div className="todo-panel" data-mode={view.mode} data-expanded={expanded}>
            <button
              type="button"
              className="todo-panel__header"
              onClick={handleHeaderClick}
              aria-expanded={expanded}
            >
              <span className="todo-panel__caret" data-collapsed={!expanded} aria-hidden="true">▾</span>
              <span className="todo-panel__title">当前计划</span>
              <span className="todo-panel__progress" aria-label={`已完成 ${completed} 项，共 ${total} 项`}>
                {completed}/{total}
              </span>
            </button>

            {expanded && (
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
                      // 用全局索引作 key：compact 窗口滑动时同一条保持稳定，保留 flash 动画
                      key={`todo-${view.hiddenBefore + idx}`}
                      todo={todo}
                      changed={Boolean(todo.changed)}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
