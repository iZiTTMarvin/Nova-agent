// @vitest-environment jsdom

/**
 * 活动组步骤框的分批挂载：跟随时首批就是最新的步骤，展开动画结束后补齐，追平后新增项立即可见。
 */
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ActivityScrollBox } from '../../../src/renderer/features/chat/ActivityScrollBox'
import { act, renderDom } from './renderDom'

function box(total: number, follow: boolean) {
  return (
    <ActivityScrollBox total={total} follow={follow} onHeightChange={() => {}}>
      {(start, end) => (
        <ul>
          {Array.from({ length: end - start }, (_, i) => (
            <li key={start + i} data-step={start + i} />
          ))}
        </ul>
      )}
    </ActivityScrollBox>
  )
}

function mountedSteps(container: HTMLElement): number[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[data-step]')).map(el => Number(el.dataset.step))
}

describe('ActivityScrollBox 分批挂载', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => cb(performance.now()), 16))
    vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id))
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('跟随时首批挂最新一屏，动画后补齐；追平后新增项立即可见', () => {
    const view = renderDom(box(60, true))
    const first = mountedSteps(view.container)
    expect(first.length).toBeLessThan(60)
    expect(first.at(-1)).toBe(59)

    for (let i = 0; i < 20; i++) act(() => { vi.advanceTimersByTime(50) })
    expect(mountedSteps(view.container)).toHaveLength(60)

    view.render(box(61, true))
    expect(mountedSteps(view.container).at(-1)).toBe(60)
    view.unmount()
  })

  it('不跟随（已完成的组）从第一步开始挂载', () => {
    const view = renderDom(box(60, false))
    expect(mountedSteps(view.container)[0]).toBe(0)
    view.unmount()
  })
})
