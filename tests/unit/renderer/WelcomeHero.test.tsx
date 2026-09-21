// @vitest-environment jsdom

import React from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WelcomeHero } from '../../../src/renderer/features/chat/WelcomeHero'
import { pupilOffset } from '../../../src/renderer/features/chat/useWelcomeMascotGaze'
import { act, renderDom } from './renderDom'

function parseTranslate(el: Element | null): { x: number; y: number } {
  const text = el?.getAttribute('transform') ?? ''
  const match = /translate\(([-\d.]+)\s+([-\d.]+)\)/.exec(text)
  return { x: Number(match?.[1] ?? 0), y: Number(match?.[2] ?? 0) }
}

describe('pupilOffset', () => {
  it('指针在眼睛上时瞳孔回正', () => {
    expect(pupilOffset(0, 0)).toEqual({ x: 0, y: 0 })
    expect(pupilOffset(0.4, 0.2)).toEqual({ x: 0, y: 0 })
  })

  it('向右看时 x 为正，并限制在最大位移内', () => {
    const look = pupilOffset(400, 0, 4.2, 280)
    expect(look.x).toBeGreaterThan(3)
    expect(look.x).toBeLessThanOrEqual(4.2)
    expect(look.y).toBeCloseTo(0)
  })
})

describe('WelcomeHero 空态', () => {
  let rafCallbacks: FrameRequestCallback[] = []
  const originalRaf = globalThis.requestAnimationFrame
  const originalCancelRaf = globalThis.cancelAnimationFrame
  const originalRect = SVGSVGElement.prototype.getBoundingClientRect

  beforeEach(() => {
    rafCallbacks = []
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      rafCallbacks.push(cb)
      return rafCallbacks.length
    }) as typeof globalThis.requestAnimationFrame
    globalThis.cancelAnimationFrame = ((id: number) => {
      rafCallbacks = rafCallbacks.filter((_, index) => index + 1 !== id)
    }) as typeof globalThis.cancelAnimationFrame
    SVGSVGElement.prototype.getBoundingClientRect = () => ({
      x: 100,
      y: 80,
      width: 200,
      height: 200,
      top: 80,
      left: 100,
      right: 300,
      bottom: 280,
      toJSON: () => ({})
    })
  })

  afterEach(() => {
    globalThis.requestAnimationFrame = originalRaf
    globalThis.cancelAnimationFrame = originalCancelRaf
    SVGSVGElement.prototype.getBoundingClientRect = originalRect
  })

  function flushRaf(times = 16): void {
    for (let i = 0; i < times; i += 1) {
      const batch = rafCallbacks.splice(0)
      if (batch.length === 0) break
      act(() => {
        for (const cb of batch) cb(i * 16)
      })
    }
  }

  function dispatchPointerMove(clientX: number, clientY: number): void {
    const event = new Event('pointermove', { bubbles: true })
    Object.defineProperty(event, 'clientX', { value: clientX })
    Object.defineProperty(event, 'clientY', { value: clientY })
    window.dispatchEvent(event)
  }

  it('不再渲染空态标语和 / @ 教程', () => {
    const renderer = renderDom(<WelcomeHero />)
    expect(renderer.container.textContent ?? '').not.toContain('说出你的想法')
    expect(renderer.container.textContent ?? '').not.toContain('唤起能力技能')
    expect(renderer.container.querySelector('kbd')).toBeNull()
    expect(renderer.container.querySelector('.welcome-mascot')).not.toBeNull()
    renderer.unmount()
  })

  it('指针右移时瞳孔向右看', () => {
    const renderer = renderDom(<WelcomeHero />)
    const pupils = renderer.container.querySelectorAll('.welcome-mascot__pupil')
    expect(pupils.length).toBe(2)

    act(() => {
      dispatchPointerMove(420, 180)
    })
    flushRaf()

    const left = parseTranslate(pupils[0])
    const right = parseTranslate(pupils[1])
    expect(left.x).toBeGreaterThan(1)
    expect(right.x).toBeGreaterThan(1)
    renderer.unmount()
  })

  it('prefers-reduced-motion 时瞳孔保持静止', () => {
    const originalMatchMedia = Object.getOwnPropertyDescriptor(window, 'matchMedia')
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: (query: string): MediaQueryList => ({
        matches: query.includes('prefers-reduced-motion'),
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false
      })
    })

    const renderer = renderDom(<WelcomeHero />)
    const pupils = renderer.container.querySelectorAll('.welcome-mascot__pupil')
    act(() => {
      dispatchPointerMove(420, 180)
    })
    flushRaf()

    expect(parseTranslate(pupils[0])).toEqual({ x: 0, y: 0 })
    expect(parseTranslate(pupils[1])).toEqual({ x: 0, y: 0 })
    renderer.unmount()

    if (originalMatchMedia) {
      Object.defineProperty(window, 'matchMedia', originalMatchMedia)
    }
  })
})
