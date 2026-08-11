// @vitest-environment jsdom

import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ContentTopBar } from '../../../src/renderer/components/ContentTopBar'
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
  PanelLeftIcon: () => null,
  PanelRightIcon: () => null
}))

// 面包屑是 chat 领域组件，顶行布局测试不依赖其数据链路
vi.mock('../../../src/renderer/features/chat/SessionBreadcrumb', () => ({
  SessionBreadcrumb: () => null
}))

const mockInvoke = vi.fn()

describe('ContentTopBar 布局开关', () => {
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

  it('渲染 inspector 布局按钮', () => {
    const renderer = renderDom(<ContentTopBar />)
    expect(
      renderer.container.querySelector('[aria-label="审查与文件面板"]')
    ).not.toBeNull()
    renderer.unmount()
  })

  it('点击 inspector 按钮调用 toggleInspector，打开时呈现 active 类', () => {
    const renderer = renderDom(<ContentTopBar />)
    const btn = renderer.container.querySelector<HTMLButtonElement>(
      '[aria-label="审查与文件面板"]'
    )
    expect(btn?.className).not.toContain('content-topbar__btn--active')

    act(() => {
      btn?.click()
    })

    expect(useLayoutStore.getState().inspectorOpen).toBe(true)
    expect(btn?.className).toContain('content-topbar__btn--active')
    renderer.unmount()
  })

  it('侧栏展开时不渲染侧栏开关（开关在侧栏自己的顶行里）', () => {
    const renderer = renderDom(<ContentTopBar />)
    expect(
      renderer.container.querySelector('[aria-label="展开会话导航"]')
    ).toBeNull()
    renderer.unmount()
  })

  it('侧栏折叠后顶行出现展开入口，点击调 toggleSidebar', () => {
    act(() => {
      useLayoutStore.getState().toggleSidebar()
    })
    const renderer = renderDom(<ContentTopBar />)
    const btn = renderer.container.querySelector<HTMLButtonElement>(
      '[aria-label="展开会话导航"]'
    )
    expect(btn).not.toBeNull()

    act(() => {
      btn?.click()
    })

    expect(useLayoutStore.getState().sidebarCollapsed).toBe(false)
    renderer.unmount()
  })
})
