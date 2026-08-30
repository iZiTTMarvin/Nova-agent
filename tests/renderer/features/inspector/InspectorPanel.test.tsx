// @vitest-environment jsdom

import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InspectorPanel } from '../../../../src/renderer/features/inspector/InspectorPanel'
import {
  resetLayoutStoreForTests,
  useLayoutStore
} from '../../../../src/renderer/stores/useLayoutStore'
import { act, renderDom } from '../../../unit/renderer/renderDom'

vi.mock('../../../../src/renderer/components/Icons', () => ({
  CloseIcon: () => null
}))

vi.mock('../../../../src/renderer/features/inspector/ReviewTab', () => ({
  ReviewTab: () => <div data-testid="review-tab" />
}))

vi.mock('../../../../src/renderer/features/inspector/FilesTab', () => ({
  FilesTab: () => <div data-testid="files-tab" />
}))

vi.mock('../../../../src/renderer/features/inspector/PlanInspectorView', () => ({
  PlanInspectorView: () => <div data-testid="plan-inspector" />
}))

/** 受控 rAF：队列手动 flush，用于断言“每帧最多写一次宽度” */
function installControllableRaf() {
  const queue = new Map<number, FrameRequestCallback>()
  let nextId = 1
  const raf = vi.fn((cb: FrameRequestCallback) => {
    const id = nextId++
    queue.set(id, cb)
    return id
  })
  const cancel = vi.fn((id: number) => {
    queue.delete(id)
  })
  vi.stubGlobal('requestAnimationFrame', raf)
  vi.stubGlobal('cancelAnimationFrame', cancel)
  return {
    cancel,
    flush() {
      const pending = [...queue.values()]
      queue.clear()
      for (const cb of pending) cb(0)
    },
    pendingCount: () => queue.size
  }
}

describe('InspectorPanel', () => {
  beforeEach(() => {
    resetLayoutStoreForTests()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('打开时用 transform 合成器动画归零，关闭时滑出 100%', () => {
    const renderer = renderDom(<InspectorPanel />)
    const aside = renderer.container.querySelector<HTMLElement>('.inspector-panel')
    expect(aside).not.toBeNull()
    // 默认关闭：滑出 + 宽度 0
    expect(aside?.style.transform).toBe('translateX(100%)')
    expect(aside?.style.width).toBe('0px')

    act(() => {
      useLayoutStore.getState().toggleInspector()
    })
    expect(aside?.style.transform).toBe('translateX(0)')
    const openWidth = useLayoutStore.getState().inspectorWidth
    expect(aside?.style.width).toBe(`${openWidth}px`)
    renderer.unmount()
  })

  it('计划 surface 使用同一个面板壳且不并列显示标准 tabs', () => {
    const renderer = renderDom(<InspectorPanel />)
    act(() => {
      useLayoutStore.getState().openPlan({ sessionId: 's1', messageId: 'm1', toolCallId: 'p1' })
    })

    expect(renderer.container.querySelector('[data-testid="plan-inspector"]')).not.toBeNull()
    expect(renderer.container.querySelector('.inspector-panel__tabs')).toBeNull()
    expect(renderer.container.querySelectorAll('.inspector-panel')).toHaveLength(1)
    renderer.unmount()
  })

  it('拖拽期间外壳宽度按帧合并写入且不写 store，内层冻结；松手一次性提交最后位置', () => {
    const raf = installControllableRaf()
    const renderer = renderDom(<InspectorPanel />)
    act(() => {
      useLayoutStore.getState().toggleInspector()
    })
    const aside = renderer.container.querySelector<HTMLElement>('.inspector-panel')
    const inner = renderer.container.querySelector<HTMLElement>('.inspector-panel__inner')
    const handle = aside?.querySelector<HTMLElement>('.inspector-panel__resize')
    expect(aside).not.toBeNull()
    expect(handle).not.toBeNull()
    const startWidth = useLayoutStore.getState().inspectorWidth

    // 开始拖拽（右侧面板：左移增大宽度）
    act(() => {
      handle!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 800 }))
    })
    // 同一帧内多次 mousemove：只调度一个 rAF，帧执行前外壳保持已提交宽度
    act(() => {
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 760 }))
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 730 }))
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 700 }))
    })
    expect(raf.pendingCount()).toBe(1)
    expect(aside!.style.width).toBe(`${startWidth}px`)

    // 帧执行：一次写消费最新 clientX
    act(() => {
      raf.flush()
    })
    expect(aside!.style.width).toBe(`${startWidth + 100}px`)
    expect(useLayoutStore.getState().inspectorWidth).toBe(startWidth)
    // 内层保持已提交宽度，不随外壳逐帧变化
    expect(inner!.style.width).toBe(`${startWidth}px`)

    // 待执行帧存在时 mouseup：先消费最后位置再提交，不落后一帧
    act(() => {
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 750 }))
      window.dispatchEvent(new MouseEvent('mouseup'))
    })
    expect(raf.cancel).toHaveBeenCalled()
    expect(useLayoutStore.getState().inspectorWidth).toBe(startWidth + 50)
    expect(aside!.style.width).toBe(`${startWidth + 50}px`)
    // 提交后内层一次切换到最终宽度
    expect(inner!.style.width).toBe(`${startWidth + 50}px`)
    renderer.unmount()
  })

  it('拖拽达到边界时宽度仍被 clamp 在最小/最大值内', () => {
    installControllableRaf()
    const renderer = renderDom(<InspectorPanel />)
    act(() => {
      useLayoutStore.getState().toggleInspector()
    })
    const aside = renderer.container.querySelector<HTMLElement>('.inspector-panel')
    const handle = aside?.querySelector<HTMLElement>('.inspector-panel__resize')
    act(() => {
      handle!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 800 }))
    })
    act(() => {
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: -2000 }))
      window.dispatchEvent(new MouseEvent('mouseup'))
    })
    const finalWidth = useLayoutStore.getState().inspectorWidth
    expect(finalWidth).toBe(640)

    act(() => {
      handle!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 800 }))
    })
    act(() => {
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 2000 }))
      window.dispatchEvent(new MouseEvent('mouseup'))
    })
    expect(useLayoutStore.getState().inspectorWidth).toBe(320)
    renderer.unmount()
  })

  it('拖拽开始/结束通知成对触发，卸载路径同样结束会话并取消待执行帧', () => {
    const raf = installControllableRaf()
    const events: boolean[] = []
    const renderer = renderDom(
      <InspectorPanel onDragSessionChange={(active) => events.push(active)} />
    )
    act(() => {
      useLayoutStore.getState().toggleInspector()
    })
    const aside = renderer.container.querySelector<HTMLElement>('.inspector-panel')
    const handle = aside?.querySelector<HTMLElement>('.inspector-panel__resize')

    act(() => {
      handle!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 800 }))
    })
    act(() => {
      window.dispatchEvent(new MouseEvent('mouseup'))
    })
    expect(events).toEqual([true, false])

    // 拖拽中卸载：待执行帧被取消，会话以结束通知收尾
    events.length = 0
    act(() => {
      handle!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 800 }))
    })
    act(() => {
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 700 }))
    })
    expect(raf.pendingCount()).toBe(1)
    renderer.unmount()
    expect(raf.cancel).toHaveBeenCalled()
    expect(raf.pendingCount()).toBe(0)
    // 第二次会话同样成对：开始通知在 mousedown，结束通知在卸载清理
    expect(events).toEqual([true, false])
  })
})
