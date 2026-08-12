import React, { useEffect, useState } from 'react'

type Point = {
  x: number
  y: number
}

type OrbShape = {
  name: 'N' | 'O' | 'V' | 'A'
  points: Point[]
}

export const NOVA_WORKING_ORB_DOT_COUNT = 24

const SHAPE_INTERVAL_MS = 1500
const SHAPE_SCALE = 0.54

function resamplePolyline(points: Point[], count: number, closed = false): Point[] {
  const path = closed ? [...points, points[0]] : points
  const segments: Array<{ from: Point; to: Point; length: number }> = []
  let totalLength = 0

  for (let i = 0; i < path.length - 1; i += 1) {
    const from = path[i]
    const to = path[i + 1]
    const length = Math.hypot(to.x - from.x, to.y - from.y)
    segments.push({ from, to, length })
    totalLength += length
  }

  const divisor = closed ? count : Math.max(1, count - 1)

  return Array.from({ length: count }, (_, index) => {
    const target = (index / divisor) * totalLength
    let traversed = 0

    for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
      const segment = segments[segmentIndex]
      const isLast = segmentIndex === segments.length - 1

      if (target <= traversed + segment.length || isLast) {
        const local = segment.length === 0
          ? 0
          : Math.min(1, Math.max(0, (target - traversed) / segment.length))

        return {
          x: segment.from.x + (segment.to.x - segment.from.x) * local,
          y: segment.from.y + (segment.to.y - segment.from.y) * local
        }
      }

      traversed += segment.length
    }

    return points[points.length - 1]
  })
}

function sampleEllipse(count: number): Point[] {
  return Array.from({ length: count }, (_, index) => {
    const angle = -Math.PI / 2 + (index / count) * Math.PI * 2
    return {
      x: Math.cos(angle) * 0.56,
      y: Math.sin(angle) * 0.68
    }
  })
}

const SHAPES: OrbShape[] = [
  {
    name: 'N',
    points: resamplePolyline([
      { x: -0.52, y: -0.68 },
      { x: -0.52, y: 0.68 },
      { x: 0.52, y: -0.68 },
      { x: 0.52, y: 0.68 }
    ], NOVA_WORKING_ORB_DOT_COUNT)
  },
  {
    name: 'O',
    points: sampleEllipse(NOVA_WORKING_ORB_DOT_COUNT)
  },
  {
    name: 'V',
    points: resamplePolyline([
      { x: -0.6, y: -0.64 },
      { x: 0, y: 0.72 },
      { x: 0.6, y: -0.64 }
    ], NOVA_WORKING_ORB_DOT_COUNT)
  },
  {
    // A 故意保留为三角轮廓：小尺寸下比带横杠的标准 A 更干净，也更像 Nova 自己的符号。
    name: 'A',
    points: resamplePolyline([
      { x: -0.58, y: 0.62 },
      { x: 0, y: -0.72 },
      { x: 0.58, y: 0.62 }
    ], NOVA_WORKING_ORB_DOT_COUNT, true)
  }
]

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export interface NovaWorkingOrbProps {
  size?: number
}

/**
 * Nova 的工作中品牌动效。
 *
 * 24 个点只在形状切换时更新一次位置，实际过渡交给 CSS transform，
 * 避免为等待态常驻 requestAnimationFrame / React 高频重渲染。
 */
export const NovaWorkingOrb = React.memo(function NovaWorkingOrb({
  size = 28
}: NovaWorkingOrbProps) {
  const [shapeIndex, setShapeIndex] = useState(0)

  useEffect(() => {
    if (prefersReducedMotion()) return undefined

    const timer = window.setInterval(() => {
      setShapeIndex(current => (current + 1) % SHAPES.length)
    }, SHAPE_INTERVAL_MS)

    return () => window.clearInterval(timer)
  }, [])

  const shape = SHAPES[shapeIndex]
  const pixelScale = size * SHAPE_SCALE

  return (
    <span
      className="nova-working-orb"
      style={{ width: size, height: size }}
      data-shape={shape.name}
      aria-hidden="true"
    >
      <span className="nova-working-orb__halo" />
      {shape.points.map((point, index) => (
        <span
          key={index}
          className="nova-working-orb__dot"
          style={{
            transform: `translate3d(${(point.x * pixelScale).toFixed(2)}px, ${(point.y * pixelScale).toFixed(2)}px, 0)`,
            transitionDelay: `${index * 6}ms`
          }}
        />
      ))}
    </span>
  )
})
