import { useEffect, type RefObject } from 'react'

export const LEFT_EYE = { x: 53, y: 56 }
export const RIGHT_EYE = { x: 72, y: 54 }
export const MAX_PUPIL = 2.4
export const GAZE_RANGE_PX = 280
const LERP = 0.16
const IDLE_MS = 1500
const SETTLE_EPS = 0.03

export function pupilOffset(
  dxPx: number,
  dyPx: number,
  max = MAX_PUPIL,
  rangePx = GAZE_RANGE_PX
): { x: number; y: number } {
  const dist = Math.hypot(dxPx, dyPx)
  if (dist < 1) return { x: 0, y: 0 }
  const scale = Math.min(1, dist / rangePx)
  const mag = max * scale
  return { x: (dxPx / dist) * mag, y: (dyPx / dist) * mag }
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

function svgPoint(matrix: DOMMatrix, x: number, y: number): { x: number; y: number } {
  return {
    x: matrix.a * x + matrix.c * y + matrix.e,
    y: matrix.b * x + matrix.d * y + matrix.f
  }
}

function localGaze(matrix: DOMMatrix, dx: number, dy: number): { x: number; y: number } {
  // 字标只等比缩放与旋转；屏幕方向须转回星星的局部坐标。
  const scale = Math.hypot(matrix.a, matrix.b)
  return pupilOffset(
    (matrix.a * dx + matrix.b * dy) / scale,
    (matrix.c * dx + matrix.d * dy) / scale
  )
}

function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * t
}

export interface WelcomeMascotGazeRefs {
  rootRef: RefObject<HTMLElement | null>
  svgRef: RefObject<SVGSVGElement | null>
  leftPupilRef: RefObject<SVGGElement | null>
  rightPupilRef: RefObject<SVGGElement | null>
}

/**
 * 空态吉祥物目光：指针位置只进 ref，rAF 写 transform，不触发 React 重绘。
 */
export function useWelcomeMascotGaze({
  rootRef,
  svgRef,
  leftPupilRef,
  rightPupilRef
}: WelcomeMascotGazeRefs): void {
  useEffect(() => {
    const root = rootRef.current
    const svg = svgRef.current
    const leftPupil = leftPupilRef.current
    const rightPupil = rightPupilRef.current
    if (!root || !svg || !leftPupil || !rightPupil) return
    if (prefersReducedMotion()) return

    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    let alive = true
    let lookingAtComposer = false
    let raf = 0
    let lastMoveAt = 0
    let lastBlinkAt = 0
    let blinkTimer = 0
    let blinkHideTimer = 0
    let blinkDoubleTimer = 0
    let blinkDoubleHideTimer = 0
    const pointer = { x: 0, y: 0, has: false }
    const current = { lx: 0, ly: 0, rx: 0, ry: 0 }
    const target = { lx: 0, ly: 0, rx: 0, ry: 0 }

    const apply = (): void => {
      leftPupil.setAttribute('transform', `translate(${current.lx.toFixed(2)} ${current.ly.toFixed(2)})`)
      rightPupil.setAttribute('transform', `translate(${current.rx.toFixed(2)} ${current.ry.toFixed(2)})`)
    }

    const restPose = (): void => {
      current.lx = current.ly = current.rx = current.ry = 0
      target.lx = target.ly = target.rx = target.ry = 0
      apply()
    }

    const retarget = (): void => {
      if (!lookingAtComposer && (!pointer.has || Date.now() - lastMoveAt > IDLE_MS)) {
        target.lx = target.ly = target.rx = target.ry = 0
        return
      }
      const matrix = svg.getScreenCTM?.()
      if (!matrix) return
      if (lookingAtComposer) {
        const look = localGaze(matrix, 0, GAZE_RANGE_PX)
        target.lx = target.rx = look.x
        target.ly = target.ry = look.y
        return
      }
      const left = svgPoint(matrix, LEFT_EYE.x, LEFT_EYE.y)
      const right = svgPoint(matrix, RIGHT_EYE.x, RIGHT_EYE.y)
      const lookL = localGaze(matrix, pointer.x - left.x, pointer.y - left.y)
      const lookR = localGaze(matrix, pointer.x - right.x, pointer.y - right.y)
      target.lx = lookL.x
      target.ly = lookL.y
      target.rx = lookR.x
      target.ry = lookR.y
    }

    const tick = (): void => {
      raf = 0
      if (!alive || document.hidden || mq.matches) return
      retarget()
      current.lx = lerp(current.lx, target.lx, LERP)
      current.ly = lerp(current.ly, target.ly, LERP)
      current.rx = lerp(current.rx, target.rx, LERP)
      current.ry = lerp(current.ry, target.ry, LERP)
      apply()
      const settling =
        Math.abs(current.lx - target.lx) < SETTLE_EPS
        && Math.abs(current.ly - target.ly) < SETTLE_EPS
        && Math.abs(current.rx - target.rx) < SETTLE_EPS
        && Math.abs(current.ry - target.ry) < SETTLE_EPS
      if (!settling) raf = window.requestAnimationFrame(tick)
    }

    const kick = (): void => {
      if (!alive || raf || document.hidden || mq.matches) return
      raf = window.requestAnimationFrame(tick)
    }

    const onPointerMove = (event: PointerEvent): void => {
      if (mq.matches) return
      // 目光跟随最近的交互，不被输入框持续持有的焦点锁住。
      lookingAtComposer = false
      pointer.x = event.clientX
      pointer.y = event.clientY
      pointer.has = true
      lastMoveAt = Date.now()
      kick()
    }

    const onPointerLeave = (): void => {
      pointer.has = false
      kick()
    }

    const onComposerActivity = (event: Event): void => {
      const targetEl = event.target
      if (!(targetEl instanceof Node)) return
      const area = root.closest('.chat-panel__composer-area')
      lookingAtComposer = !!area?.contains(targetEl)
      if (lookingAtComposer) kick()
    }

    const onFocusOut = (): void => {
      lookingAtComposer = false
      kick()
    }

    const clearBlinkClass = (): void => {
      root.classList.remove('welcome-mascot--blink')
    }

    const scheduleBlink = (): void => {
      if (!alive || mq.matches) return
      const wait = 6000 + Math.random() * 4000
      blinkTimer = window.setTimeout(() => {
        if (!alive || mq.matches) return
        const now = Date.now()
        if (now - lastBlinkAt < 900 || document.hidden) {
          scheduleBlink()
          return
        }
        lastBlinkAt = now
        root.classList.add('welcome-mascot--blink')
        blinkHideTimer = window.setTimeout(() => {
          if (!alive) return
          clearBlinkClass()
          if (Math.random() < 0.16) {
            blinkDoubleTimer = window.setTimeout(() => {
              if (!alive || mq.matches) return
              root.classList.add('welcome-mascot--blink')
              blinkDoubleHideTimer = window.setTimeout(clearBlinkClass, 110)
            }, 90)
          }
        }, 130)
        scheduleBlink()
      }, wait)
    }

    const onVisibility = (): void => {
      if (document.hidden) {
        if (raf) window.cancelAnimationFrame(raf)
        raf = 0
        restPose()
        clearBlinkClass()
        return
      }
      kick()
    }

    const onReducedChange = (): void => {
      if (!mq.matches) return
      if (raf) window.cancelAnimationFrame(raf)
      raf = 0
      restPose()
      clearBlinkClass()
    }

    window.addEventListener('pointermove', onPointerMove, { passive: true })
    document.documentElement.addEventListener('pointerleave', onPointerLeave)
    document.addEventListener('focusin', onComposerActivity)
    document.addEventListener('input', onComposerActivity)
    document.addEventListener('focusout', onFocusOut)
    document.addEventListener('visibilitychange', onVisibility)
    mq.addEventListener('change', onReducedChange)
    scheduleBlink()

    return () => {
      alive = false
      window.removeEventListener('pointermove', onPointerMove)
      document.documentElement.removeEventListener('pointerleave', onPointerLeave)
      document.removeEventListener('focusin', onComposerActivity)
      document.removeEventListener('input', onComposerActivity)
      document.removeEventListener('focusout', onFocusOut)
      document.removeEventListener('visibilitychange', onVisibility)
      mq.removeEventListener('change', onReducedChange)
      window.clearTimeout(blinkTimer)
      window.clearTimeout(blinkHideTimer)
      window.clearTimeout(blinkDoubleTimer)
      window.clearTimeout(blinkDoubleHideTimer)
      if (raf) window.cancelAnimationFrame(raf)
      clearBlinkClass()
      restPose()
    }
  }, [rootRef, svgRef, leftPupilRef, rightPupilRef])
}
