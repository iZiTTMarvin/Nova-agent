/**
 * 活动组展开后的步骤滚动框：固定最大高度、框内滚动、底边可拖动调整高度。
 *
 * - 分批挂载：展开时只挂一屏（跟随时是最新一屏），动画结束后再逐帧补齐，避免一次挂载上百行与展开动画抢帧；
 *   未挂载部分用等高占位保持滚动条稳定。
 * - 跟随底部：follow 时新步骤进来自动滚到底；用户上翻后不再拉回，直到回到底部。
 * - 拖动高度期间直接写 DOM 样式，松手才提交给上层，拖动过程不触发 React 重渲染。
 */
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useScrollFadeMask } from '../../hooks/useScrollFadeMask'
import './ActivityScrollBox.css'

export const ACTIVITY_BOX_DEFAULT_HEIGHT = 240
const MIN_HEIGHT = 96
const MAX_VIEWPORT_RATIO = 0.7
const KEYBOARD_STEP = 28
/** 与行高一致：占位与 content-visibility 的预估尺寸都按它算 */
const ESTIMATED_ITEM_HEIGHT = 28
const INITIAL_BATCH = 16
const FRAME_BATCH = 24
/** 略长于折叠壳 240ms 的展开过渡 */
const FILL_DELAY_MS = 260
const STICK_TOLERANCE = 8

export interface ActivityScrollBoxProps {
  total: number
  /** 回合进行中的末段：新内容进来时贴底 */
  follow: boolean
  /** 用户拖出来的最大高度；未设置用默认值 */
  height?: number
  onHeightChange: (height: number | undefined) => void
  /** 只渲染 [start, end) 区间的项；区间外用等高占位 */
  children: (start: number, end: number) => React.ReactNode
}

function maxAllowedHeight(): number {
  const viewport = typeof window === 'undefined' ? 0 : window.innerHeight
  return Math.max(MIN_HEIGHT, Math.round(viewport * MAX_VIEWPORT_RATIO) || ACTIVITY_BOX_DEFAULT_HEIGHT * 2)
}

function clampHeight(value: number): number {
  return Math.min(maxAllowedHeight(), Math.max(MIN_HEIGHT, Math.round(value)))
}

/**
 * 分批挂载的可见区间。首批只挂一屏，并锚定在用户会先看到的一端（跟随时是底部）；
 * 等展开动画结束再逐帧补齐，避免挂载与动画抢同一批帧。追平一次后，流式追加的新项直接可见。
 */
function useProgressiveRange(total: number, anchorEnd: boolean): { start: number; end: number } {
  const [count, setCount] = useState(() => Math.min(total, INITIAL_BATCH))
  const [caughtUp, setCaughtUp] = useState(() => total <= INITIAL_BATCH)
  const [ready, setReady] = useState(false)
  const anchorEndRef = useRef(anchorEnd)

  useEffect(() => {
    const timer = window.setTimeout(() => setReady(true), FILL_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [])

  useEffect(() => {
    if (caughtUp || !ready) return
    if (count >= total) {
      setCaughtUp(true)
      return
    }
    const raf = requestAnimationFrame(() => {
      setCount(previous => Math.min(total, previous + FRAME_BATCH))
    })
    return () => cancelAnimationFrame(raf)
  }, [caughtUp, ready, count, total])

  if (caughtUp) return { start: 0, end: total }
  const visible = Math.min(count, total)
  // 锚定端只在挂载时决定，补齐过程中不来回切换
  return anchorEndRef.current
    ? { start: total - visible, end: total }
    : { start: 0, end: visible }
}

export const ActivityScrollBox: React.FC<ActivityScrollBoxProps> = function ActivityScrollBox({
  total,
  follow,
  height,
  onHeightChange,
  children
}) {
  const scrollerRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)
  const followRef = useRef(follow)
  followRef.current = follow
  const [overflowing, setOverflowing] = useState(false)
  const { start, end } = useProgressiveRange(total, follow)
  const limit = height ?? ACTIVITY_BOX_DEFAULT_HEIGHT

  useScrollFadeMask(scrollerRef, { fadeSize: 18 })

  // 挂载即贴底：进行中的末段从最新一步开始看（只在挂载时执行一次）
  useLayoutEffect(() => {
    const el = scrollerRef.current
    if (el && followRef.current) el.scrollTop = el.scrollHeight
  }, [])

  useEffect(() => {
    const scroller = scrollerRef.current
    const content = contentRef.current
    if (!scroller || !content || typeof ResizeObserver === 'undefined') return
    const sync = (): void => {
      if (followRef.current && stickRef.current) scroller.scrollTop = scroller.scrollHeight
      setOverflowing(scroller.scrollHeight - scroller.clientHeight > 1)
    }
    const ro = new ResizeObserver(sync)
    ro.observe(content)
    ro.observe(scroller)
    return () => ro.disconnect()
  }, [])

  const handleScroll = useCallback(() => {
    const el = scrollerRef.current
    if (!el) return
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_TOLERANCE
  }, [])

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    const scroller = scrollerRef.current
    if (!scroller || event.button !== 0) return
    event.preventDefault()
    const handle = event.currentTarget
    handle.setPointerCapture(event.pointerId)
    const startY = event.clientY
    const startHeight = scroller.getBoundingClientRect().height
    let next = startHeight
    let raf = 0

    const onMove = (move: PointerEvent): void => {
      next = clampHeight(startHeight + move.clientY - startY)
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        scroller.style.maxHeight = `${next}px`
      })
    }
    const onUp = (): void => {
      cancelAnimationFrame(raf)
      scroller.style.maxHeight = `${next}px`
      handle.removeEventListener('pointermove', onMove)
      handle.removeEventListener('pointerup', onUp)
      handle.removeEventListener('pointercancel', onUp)
      handle.classList.remove('activity-scroll__handle--dragging')
      onHeightChange(next)
    }
    handle.classList.add('activity-scroll__handle--dragging')
    handle.addEventListener('pointermove', onMove)
    handle.addEventListener('pointerup', onUp)
    handle.addEventListener('pointercancel', onUp)
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const current = scrollerRef.current?.getBoundingClientRect().height ?? limit
    let next: number | null = null
    if (event.key === 'ArrowDown') next = current + KEYBOARD_STEP
    else if (event.key === 'ArrowUp') next = current - KEYBOARD_STEP
    else if (event.key === 'Home') next = MIN_HEIGHT
    else if (event.key === 'End') next = maxAllowedHeight()
    if (next === null) return
    event.preventDefault()
    onHeightChange(clampHeight(next))
  }

  return (
    <div className="activity-scroll">
      <div
        ref={scrollerRef}
        className="activity-scroll__viewport"
        style={{ maxHeight: `${limit}px` }}
        onScroll={handleScroll}
        data-testid="activity-scroll"
      >
        <div ref={contentRef}>
          {start > 0 && <div aria-hidden="true" style={{ height: start * ESTIMATED_ITEM_HEIGHT }} />}
          {children(start, end)}
          {end < total && (
            <div aria-hidden="true" style={{ height: (total - end) * ESTIMATED_ITEM_HEIGHT }} />
          )}
        </div>
      </div>
      {(overflowing || height !== undefined) && (
        <div
          className="activity-scroll__handle"
          role="separator"
          aria-orientation="horizontal"
          aria-label="调整步骤列表高度，双击恢复默认"
          aria-valuemin={MIN_HEIGHT}
          aria-valuemax={maxAllowedHeight()}
          aria-valuenow={Math.round(limit)}
          tabIndex={0}
          onPointerDown={handlePointerDown}
          onKeyDown={handleKeyDown}
          onDoubleClick={() => onHeightChange(undefined)}
        />
      )}
    </div>
  )
}
