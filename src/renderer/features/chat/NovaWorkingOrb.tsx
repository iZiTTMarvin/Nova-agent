import React, { useEffect, useState } from 'react'

type Point = {
  x: number
  y: number
}

type OrbShape = {
  name: 'N' | 'O' | 'V' | 'A'
  points: Point[]
}

type OrbFrame = {
  shapeIndex: number
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

/**
 * 给每个现有点分配一个唯一目标点，并让所有点的总移动距离尽量短。
 * N/O/V/A 的拓扑不同，直接按数组下标硬插值会在中间挤成一团；
 * 这里用最小代价匹配保住点阵在整个变形过程里的均匀感。
 */
function assignNearestTargets(source: Point[], target: Point[]): Point[] {
  const size = source.length
  const rowPotential = new Array(size + 1).fill(0)
  const columnPotential = new Array(size + 1).fill(0)
  const rowForColumn = new Array(size + 1).fill(0)
  const previousColumn = new Array(size + 1).fill(0)

  for (let row = 1; row <= size; row += 1) {
    rowForColumn[0] = row
    let column0 = 0
    const minCost = new Array(size + 1).fill(Number.POSITIVE_INFINITY)
    const used = new Array(size + 1).fill(false)

    do {
      used[column0] = true
      const row0 = rowForColumn[column0]
      let delta = Number.POSITIVE_INFINITY
      let column1 = 0

      for (let column = 1; column <= size; column += 1) {
        if (used[column]) continue

        const from = source[row0 - 1]
        const to = target[column - 1]
        const dx = from.x - to.x
        const dy = from.y - to.y
        const cost = dx * dx + dy * dy - rowPotential[row0] - columnPotential[column]

        if (cost < minCost[column]) {
          minCost[column] = cost
          previousColumn[column] = column0
        }
        if (minCost[column] < delta) {
          delta = minCost[column]
          column1 = column
        }
      }

      for (let column = 0; column <= size; column += 1) {
        if (used[column]) {
          rowPotential[rowForColumn[column]] += delta
          columnPotential[column] -= delta
        } else {
          minCost[column] -= delta
        }
      }

      column0 = column1
    } while (rowForColumn[column0] !== 0)

    do {
      const column1 = previousColumn[column0]
      rowForColumn[column0] = rowForColumn[column1]
      column0 = column1
    } while (column0 !== 0)
  }

  const assigned = new Array<Point>(size)
  for (let column = 1; column <= size; column += 1) {
    assigned[rowForColumn[column] - 1] = target[column - 1]
  }

  return assigned
}

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
 * 没有常驻 requestAnimationFrame，也不会触发高频 React 重渲染。
 */
export const NovaWorkingOrb = React.memo(function NovaWorkingOrb({
  size = 28
}: NovaWorkingOrbProps) {
  const [frame, setFrame] = useState<OrbFrame>(() => ({
    shapeIndex: 0,
    points: SHAPES[0].points
  }))

  useEffect(() => {
    if (prefersReducedMotion()) return undefined

    const timer = window.setInterval(() => {
      setFrame(current => {
        const nextShapeIndex = (current.shapeIndex + 1) % SHAPES.length
        const nextShape = SHAPES[nextShapeIndex]

        return {
          shapeIndex: nextShapeIndex,
          points: assignNearestTargets(current.points, nextShape.points)
        }
      })
    }, SHAPE_INTERVAL_MS)

    return () => window.clearInterval(timer)
  }, [])

  const pixelScale = size * SHAPE_SCALE

  return (
    <span
      className="nova-working-orb"
      style={{ width: size, height: size }}
      data-shape={SHAPES[frame.shapeIndex].name}
      aria-hidden="true"
    >
      <span className="nova-working-orb__halo" />
      {frame.points.map((point, index) => (
        <span
          key={index}
          className="nova-working-orb__dot"
          style={{
            transform: `translate3d(${(point.x * pixelScale).toFixed(2)}px, ${(point.y * pixelScale).toFixed(2)}px, 0)`
          }}
        />
      ))}
    </span>
  )
})
