import { useEffect, useRef, useState, type AnimationEvent, type CSSProperties } from 'react'
import './borderBeam.css'

export type BorderBeamColor = 'colorful' | 'mono' | 'ocean' | 'sunset'

export interface BorderBeamProps {
  /** 关闭时先淡出再卸载，开启时淡入。 */
  active?: boolean
  color?: BorderBeamColor
  /** 整体强度，0–1。 */
  strength?: number
  className?: string
}

type Phase = 'idle' | 'active' | 'fading'

const FADE_OUT_ANIMATION = 'border-beam-fade-out'

/**
 * 宿主卡片内沿的流光覆盖层。宿主需 position: relative 并设置 border-radius，
 * 覆盖层继承其圆角；idle 时不渲染任何节点，也没有动画与观察器。
 */
export function BorderBeam({ active = true, color = 'colorful', strength = 0.95, className }: BorderBeamProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const [phase, setPhase] = useState<Phase>(active ? 'active' : 'idle')

  // 淡出期间保留节点，等淡出动画结束后再回到 idle
  if (active && phase === 'idle') setPhase('active')
  if (!active && phase === 'active') setPhase('fading')

  const rendered = phase !== 'idle'

  // 滚出视口时暂停，避免不可见实例继续逐帧绘制
  useEffect(() => {
    const root = rootRef.current
    if (!rendered || !root || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(
      ([entry]) => root.toggleAttribute('data-paused', !entry.isIntersecting),
      { rootMargin: '64px' }
    )
    observer.observe(root)
    return () => observer.disconnect()
  }, [rendered])

  if (!rendered) return null

  const handleAnimationEnd = (event: AnimationEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || event.animationName !== FADE_OUT_ANIMATION) return
    setPhase(active ? 'active' : 'idle')
  }

  const style = { '--beam-strength': Math.min(1, Math.max(0, strength)) } as CSSProperties

  return (
    <div
      ref={rootRef}
      aria-hidden="true"
      className={className ? `border-beam ${className}` : 'border-beam'}
      data-phase={phase}
      data-color={color}
      style={style}
      onAnimationEnd={handleAnimationEnd}
    >
      <span className="border-beam__bloom" />
    </div>
  )
}
