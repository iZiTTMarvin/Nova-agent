// @vitest-environment jsdom

import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TitleBar } from '../../../src/renderer/components/TitleBar'
import {
  resetLayoutStoreForTests,
  useLayoutStore
} from '../../../src/renderer/stores/useLayoutStore'
import { act, renderDom } from '../../unit/renderer/renderDom'

vi.mock('../../../src/renderer/components/Icons', () => ({
  MinimizeIcon: () => null,
  MaximizeIcon: () => null,
  RestoreIcon: () => null,
  CloseIcon: () => null,
  NovaLogo: () => null,
  PanelLeftIcon: () => null,
  PanelRightIcon: () => null
}))

const mockInvoke = vi.fn()

describe('TitleBar 布局开关', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetLayoutStoreForTests()
    mockInvoke.mockResolvedValue(false)
    Object.assign(window, {
      api: {
        invoke: mockInvoke,
        on: vi.fn(() => () => {}),
        removeAllListeners: vi.fn()
      }
    })
  })

  it('渲染侧栏与 inspector 两个布局按钮', () => {
    const renderer = renderDom(<TitleBar />)
    expect(
      renderer.container.querySelector('[aria-label="折叠/展开会话导航"]')
    ).not.toBeNull()
    expect(
      renderer.container.querySelector('[aria-label="审查与文件面板"]')
    ).not.toBeNull()
    renderer.unmount()
  })

  it('点击侧栏按钮调用 toggleSidebar，折叠时呈现 active 类', () => {
    const renderer = renderDom(<TitleBar />)
    const btn = renderer.container.querySelector<HTMLButtonElement>(
      '[aria-label="折叠/展开会话导航"]'
    )
    expect(btn?.className).not.toContain('title-bar__btn--layout-active')

    act(() => {
      btn?.click()
    })

    expect(useLayoutStore.getState().sidebarCollapsed).toBe(true)
    expect(btn?.className).toContain('title-bar__btn--layout-active')
    renderer.unmount()
  })

  it('点击 inspector 按钮调用 toggleInspector，打开时呈现 active 类', () => {
    const renderer = renderDom(<TitleBar />)
    const btn = renderer.container.querySelector<HTMLButtonElement>(
      '[aria-label="审查与文件面板"]'
    )
    expect(btn?.className).not.toContain('title-bar__btn--layout-active')

    act(() => {
      btn?.click()
    })

    expect(useLayoutStore.getState().inspectorOpen).toBe(true)
    expect(btn?.className).toContain('title-bar__btn--layout-active')
    renderer.unmount()
  })
})
