// @vitest-environment jsdom

import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Sidebar } from '../../../src/renderer/components/Sidebar'
import {
  resetLayoutStoreForTests,
  useLayoutStore
} from '../../../src/renderer/stores/useLayoutStore'
import { resetAgentStoreForTests } from '../../../src/renderer/stores/useAgentStore'
import { resetChatStoreForTests } from '../../../src/renderer/stores/useChatStore'
import { resetSettingsStoreForTests } from '../../../src/renderer/stores/useSettingsStore'
import { act, renderDom } from '../../unit/renderer/renderDom'

vi.mock('../../../src/renderer/components/Icons', () => ({
  NovaLogo: () => null,
  FolderIcon: () => null,
  SettingsIcon: () => null,
  PlusIcon: () => null,
  PinIcon: () => null,
  PanelLeftIcon: () => null
}))

vi.mock('@astryxdesign/core/SideNav', () => ({
  SideNav: ({ children }: { children?: React.ReactNode }) => (
    <div data-testid="sidenav">{children}</div>
  ),
  SideNavHeading: () => null,
  SideNavItem: () => null,
  SideNavSection: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>
}))

vi.mock('@astryxdesign/core/Button', () => ({
  Button: () => null
}))

vi.mock('@astryxdesign/core/IconButton', () => ({
  IconButton: () => null
}))

vi.mock('@astryxdesign/core/TextInput', () => ({
  TextInput: () => null
}))

describe('Sidebar 折叠壳', () => {
  beforeEach(() => {
    resetLayoutStoreForTests()
    resetChatStoreForTests()
    resetSettingsStoreForTests()
    resetAgentStoreForTests()
  })

  it('展开时壳宽等于 sidebarWidth；折叠时壳宽瞬时为 0 且内容 transform 滑出', () => {
    const renderer = renderDom(<Sidebar />)
    const shell = renderer.container.querySelector<HTMLElement>('.sidebar-shell')
    const inner = renderer.container.querySelector<HTMLElement>('.sidebar-shell__inner')
    expect(shell).not.toBeNull()
    expect(inner).not.toBeNull()
    expect(shell?.style.width).toBe('264px')
    expect(inner?.style.transform).toBe('translateX(0)')
    expect(shell?.getAttribute('aria-hidden')).toBe('false')
    expect(shell?.querySelector('.sidebar-shell__resize-handle')).not.toBeNull()

    act(() => {
      useLayoutStore.getState().toggleSidebar()
    })

    // 壳层宽度瞬时切换（布局只重排一次），内容 transform 滑出（合成器动画）
    expect(shell?.style.width).toBe('0px')
    expect(inner?.style.transform).toBe('translateX(-100%)')
    expect(shell?.getAttribute('aria-hidden')).toBe('true')
    expect(shell?.className).toContain('sidebar-shell--collapsed')
    expect(shell?.querySelector('.sidebar-shell__resize-handle')).toBeNull()
    renderer.unmount()
  })

  it('setSidebarWidth 后壳与内层宽度同步更新', () => {
    const renderer = renderDom(<Sidebar />)
    const shell = renderer.container.querySelector<HTMLElement>('.sidebar-shell')
    const inner = renderer.container.querySelector<HTMLElement>('.sidebar-shell__inner')

    act(() => {
      useLayoutStore.getState().setSidebarWidth(320)
    })

    expect(shell?.style.width).toBe('320px')
    expect(inner?.style.width).toBe('320px')
    renderer.unmount()
  })

  it('拖拽期间宽度直写 DOM，不触发 store；松手一次性提交', () => {
    const renderer = renderDom(<Sidebar />)
    const shell = renderer.container.querySelector<HTMLElement>('.sidebar-shell')
    const handle = shell?.querySelector<HTMLElement>('.sidebar-shell__resize-handle')
    expect(shell).not.toBeNull()
    expect(handle).not.toBeNull()

    // 开始拖拽（mousedown 在 handle 上）
    act(() => {
      handle!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 300 }))
    })
    // 拖拽中：直接改 DOM 宽度
    act(() => {
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 340 }))
    })
    // 拖拽期间：不写 store
    expect(shell!.style.width).toBe('304px')
    expect(useLayoutStore.getState().sidebarWidth).toBe(264)

    // 松手：提交一次到 store
    act(() => {
      window.dispatchEvent(new MouseEvent('mouseup'))
    })
    expect(useLayoutStore.getState().sidebarWidth).toBe(304)
    renderer.unmount()
  })
})
