/** 过程列表的 CSS Grid 折叠壳：头部保持原位，内容高度向头部收缩。 */
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import './TurnProcessCollapsible.css'

interface TurnProcessCollapsibleProps {
  open: boolean
  /** reduced motion 由调用方提前计算，避免为动画创建额外的 JS 循环 */
  reducedMotion?: boolean
  className?: string
  children: React.ReactNode
  /** 收缩时钉住折叠头，避免视口锚在答复上把头带走 */
  pinHeaderRef?: React.RefObject<HTMLElement | null>
}

function parseCssDurationMs(value: string): number {
  const first = value.split(',')[0]?.trim() ?? ''
  if (!first) return 0
  if (first.endsWith('ms')) return Number.parseFloat(first) || 0
  if (first.endsWith('s')) return (Number.parseFloat(first) || 0) * 1000
  return Number.parseFloat(first) || 0
}

function findScrollParent(el: HTMLElement): HTMLElement | null {
  let node: HTMLElement | null = el.parentElement
  while (node) {
    const overflowY = getComputedStyle(node).overflowY
    if (overflowY === 'auto' || overflowY === 'scroll') return node
    node = node.parentElement
  }
  return (document.scrollingElement as HTMLElement | null) ?? null
}

export const TurnProcessCollapsible: React.FC<TurnProcessCollapsibleProps> = React.memo(
  function TurnProcessCollapsible({
    open,
    reducedMotion = false,
    className,
    children,
    pinHeaderRef
  }) {
    const rootRef = useRef<HTMLDivElement>(null)
    const prevOpenRef = useRef(open)
    const [renderChildren, setRenderChildren] = useState(open)
    const classes = [
      'turn-process-collapsible',
      reducedMotion ? 'turn-process-collapsible--reduced' : '',
      className
    ].filter(Boolean).join(' ')

    useEffect(() => {
      if (open) {
        setRenderChildren(true)
        return
      }
      // 从未展开过（每条收起的行挂载时都走这里）就没有内容要卸载：不读计算样式。
      // 否则上百行同批挂载时，每次都会强制整页同步样式计算，形成长任务。
      if (!renderChildren) return
      if (reducedMotion) {
        setRenderChildren(false)
        return
      }
      const el = rootRef.current
      const durationMs = el
        ? parseCssDurationMs(getComputedStyle(el).transitionDuration)
        : 0
      if (durationMs <= 0) {
        setRenderChildren(false)
        return
      }
      const timer = window.setTimeout(() => setRenderChildren(false), durationMs)
      return () => window.clearTimeout(timer)
    }, [open, reducedMotion, renderChildren])

    useLayoutEffect(() => {
      const wasOpen = prevOpenRef.current
      prevOpenRef.current = open
      const header = pinHeaderRef?.current
      if (!wasOpen || open || !header) return

      const scroller = findScrollParent(header)
      if (!scroller) return
      const pinnedTop = header.getBoundingClientRect().top
      let raf = 0
      const started = performance.now()
      const durationMs = rootRef.current
        ? parseCssDurationMs(getComputedStyle(rootRef.current).transitionDuration)
        : 0
      const stop = (): void => {
        cancelAnimationFrame(raf)
        scroller.removeEventListener('wheel', stop)
        scroller.removeEventListener('touchstart', stop)
        scroller.removeEventListener('keydown', stop)
      }
      const tick = (now: number) => {
        const delta = header.getBoundingClientRect().top - pinnedTop
        if (delta !== 0) scroller.scrollTop += delta
        if (now - started < durationMs) raf = requestAnimationFrame(tick)
        else stop()
      }
      // 用户自己滚动时立即交还视口，定位动画不再抢夺
      scroller.addEventListener('wheel', stop, { passive: true })
      scroller.addEventListener('touchstart', stop, { passive: true })
      scroller.addEventListener('keydown', stop)
      raf = requestAnimationFrame(tick)
      return stop
    }, [open, pinHeaderRef])

    const handleTransitionEnd: React.TransitionEventHandler<HTMLDivElement> = event => {
      if (
        event.target === event.currentTarget &&
        !open &&
        event.propertyName === 'grid-template-rows'
      ) {
        setRenderChildren(false)
      }
    }

    return (
      <div
        ref={rootRef}
        className={classes}
        data-expanded={open}
        data-empty={!renderChildren}
        aria-hidden={!open}
        onTransitionEnd={handleTransitionEnd}
      >
        <div className="turn-process-collapsible__inner">
          {renderChildren ? children : null}
        </div>
      </div>
    )
  }
)
