/**
 * 列表拖拽与键盘无障碍重排 Hook：
 * 结合 4px 指针移动死区、目标行上下半区对撞检测（before / after）以及 Alt + ArrowUp/ArrowDown 键盘重排。
 */
import { useCallback, useRef, useState } from 'react'
import type React from 'react'

export const DRAG_REORDER_DEADZONE_PX = 4

export type DropPosition = 'before' | 'after'

export function reorderIdsByDrop(
  ids: readonly string[],
  draggedId: string,
  targetId: string,
  position: DropPosition
): string[] {
  if (draggedId === targetId) return [...ids]
  const fromIdx = ids.indexOf(draggedId)
  const targetIdx = ids.indexOf(targetId)
  if (fromIdx === -1 || targetIdx === -1) return [...ids]

  const remaining = ids.filter(id => id !== draggedId)
  const adjustedTargetIdx = remaining.indexOf(targetId)
  const insertIdx = position === 'after' ? adjustedTargetIdx + 1 : adjustedTargetIdx
  const next = [...remaining]
  next.splice(Math.min(Math.max(0, insertIdx), next.length), 0, draggedId)
  return next
}

export function reorderIdsByKeyboard(
  ids: readonly string[],
  id: string,
  direction: 'up' | 'down'
): string[] {
  const index = ids.indexOf(id)
  if (index === -1) return [...ids]
  const targetIndex = direction === 'up' ? index - 1 : index + 1
  if (targetIndex < 0 || targetIndex >= ids.length) return [...ids]

  const next = [...ids]
  const [moved] = next.splice(index, 1)
  next.splice(targetIndex, 0, moved)
  return next
}

export interface UseDraggableReorderListOptions<T> {
  items: readonly T[]
  getId: (item: T) => string
  onReorder: (nextIds: string[]) => void
}

export interface DraggableItemState {
  isDragging: boolean
  dropPosition: DropPosition | null
}

export interface DraggableItemProps {
  draggable: boolean
  onPointerDown: (e: React.PointerEvent<HTMLElement>) => void
  onPointerMove: (e: React.PointerEvent<HTMLElement>) => void
  onPointerUp: () => void
  onDragStart: (e: React.DragEvent<HTMLElement>) => void
  onDragOver: (e: React.DragEvent<HTMLElement>) => void
  onDragLeave: () => void
  onDrop: (e: React.DragEvent<HTMLElement>) => void
  onDragEnd: () => void
  onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => void
}

export function useDraggableReorderList<T>({
  items,
  getId,
  onReorder
}: UseDraggableReorderListOptions<T>) {
  const [draggedId, setDraggedId] = useState<string | null>(null)
  const [overId, setOverId] = useState<string | null>(null)
  const [dropPosition, setDropPosition] = useState<DropPosition | null>(null)

  const pointerStartRef = useRef<{ x: number; y: number; id: string } | null>(null)
  const deadzonePassedRef = useRef(false)

  const resetDragState = useCallback(() => {
    pointerStartRef.current = null
    deadzonePassedRef.current = false
    setDraggedId(null)
    setOverId(null)
    setDropPosition(null)
  }, [])

  const getItemDragState = useCallback(
    (item: T): DraggableItemState => {
      const id = getId(item)
      return {
        isDragging: draggedId === id,
        dropPosition: overId === id && draggedId !== id ? dropPosition : null
      }
    },
    [draggedId, overId, dropPosition, getId]
  )

  const getItemDragProps = useCallback(
    (item: T): DraggableItemProps => {
      const id = getId(item)
      return {
        draggable: items.length > 1,
        onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
          if (e.button !== 0) return
          pointerStartRef.current = { x: e.clientX, y: e.clientY, id }
          deadzonePassedRef.current = false
        },
        onPointerMove: (e: React.PointerEvent<HTMLElement>) => {
          const start = pointerStartRef.current
          if (!start || start.id !== id) return
          const dx = Math.abs(e.clientX - start.x)
          const dy = Math.abs(e.clientY - start.y)
          if (!deadzonePassedRef.current && (dx > DRAG_REORDER_DEADZONE_PX || dy > DRAG_REORDER_DEADZONE_PX)) {
            deadzonePassedRef.current = true
            setDraggedId(id)
          }
        },
        onPointerUp: () => {
          if (!draggedId) {
            pointerStartRef.current = null
            deadzonePassedRef.current = false
          }
        },
        onDragStart: (e: React.DragEvent<HTMLElement>) => {
          const start = pointerStartRef.current
          if (start && start.id === id && !deadzonePassedRef.current) {
            const dx = Math.abs(e.clientX - start.x)
            const dy = Math.abs(e.clientY - start.y)
            if (dx > 0 || dy > 0) {
              if (dx <= DRAG_REORDER_DEADZONE_PX && dy <= DRAG_REORDER_DEADZONE_PX) {
                e.preventDefault()
                return
              }
            }
          }
          deadzonePassedRef.current = true
          setDraggedId(id)
          if (e.dataTransfer) {
            e.dataTransfer.effectAllowed = 'move'
            try {
              e.dataTransfer.setData('text/plain', id)
            } catch {
              // ignore in synthetic test environments
            }
          }
        },
        onDragOver: (e: React.DragEvent<HTMLElement>) => {
          if (items.length <= 1) return
          e.preventDefault()
          if (e.dataTransfer) {
            e.dataTransfer.dropEffect = 'move'
          }
          const rect = e.currentTarget.getBoundingClientRect()
          const midpoint = rect.top + rect.height / 2
          const pos: DropPosition = e.clientY < midpoint ? 'before' : 'after'
          setOverId(id)
          setDropPosition(pos)
        },
        onDragLeave: () => {
          setOverId(prev => (prev === id ? null : prev))
        },
        onDrop: (e: React.DragEvent<HTMLElement>) => {
          e.preventDefault()
          let sourceId = draggedId
          if (!sourceId && e.dataTransfer) {
            try {
              sourceId = e.dataTransfer.getData('text/plain') || null
            } catch {
              sourceId = null
            }
          }
          if (!sourceId || sourceId === id) {
            resetDragState()
            return
          }
          const rect = e.currentTarget.getBoundingClientRect()
          const midpoint = rect.top + rect.height / 2
          const pos: DropPosition = dropPosition ?? (e.clientY < midpoint ? 'before' : 'after')
          const currentIds = items.map(getId)
          const nextIds = reorderIdsByDrop(currentIds, sourceId, id, pos)
          onReorder(nextIds)
          resetDragState()
        },
        onDragEnd: () => {
          resetDragState()
        },
        onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => {
          if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return
          e.preventDefault()
          e.stopPropagation()
          const currentIds = items.map(getId)
          const nextIds = reorderIdsByKeyboard(
            currentIds,
            id,
            e.key === 'ArrowUp' ? 'up' : 'down'
          )
          if (nextIds.some((nextId, idx) => nextId !== currentIds[idx])) {
            onReorder(nextIds)
          }
        }
      }
    },
    [draggedId, dropPosition, getId, items, onReorder, resetDragState]
  )

  return {
    draggedId,
    overId,
    dropPosition,
    getItemDragState,
    getItemDragProps
  }
}
