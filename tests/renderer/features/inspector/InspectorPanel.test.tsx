// @vitest-environment jsdom

import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
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

describe('InspectorPanel', () => {
  beforeEach(() => {
    resetLayoutStoreForTests()
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

  it('拖拽期间宽度直写 DOM，不触发 store / localStorage；松手一次性提交', () => {
    const renderer = renderDom(<InspectorPanel />)
    // 打开面板以渲染 resize handle
    act(() => {
      useLayoutStore.getState().toggleInspector()
    })
    const aside = renderer.container.querySelector<HTMLElement>('.inspector-panel')
    const handle = aside?.querySelector<HTMLElement>('.inspector-panel__resize')
    expect(aside).not.toBeNull()
    expect(handle).not.toBeNull()
    const startWidth = useLayoutStore.getState().inspectorWidth

    // 开始拖拽（右侧面板：左移增大宽度）
    act(() => {
      handle!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 800 }))
    })
    // 拖拽中：直接改 DOM 宽度
    act(() => {
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 700 }))
    })
    // 拖拽期间：不写 store
    expect(aside!.style.width).toBe(`${startWidth + 100}px`)
    expect(useLayoutStore.getState().inspectorWidth).toBe(startWidth)

    // 松手：提交一次到 store
    act(() => {
      window.dispatchEvent(new MouseEvent('mouseup'))
    })
    expect(useLayoutStore.getState().inspectorWidth).toBe(startWidth + 100)
    renderer.unmount()
  })
})
