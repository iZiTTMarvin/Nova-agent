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
  ChevronIcon: () => null,
  TrashIcon: () => null,
  EditIcon: () => null
}))

vi.mock('framer-motion', () => import('../../unit/renderer/_framerMotionMock'))

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

  it('展开时壳宽等于 sidebarWidth，折叠时为 0 且 aria-hidden', () => {
    const renderer = renderDom(<Sidebar />)
    const shell = renderer.container.querySelector<HTMLElement>('.sidebar-shell')
    expect(shell).not.toBeNull()
    expect(shell?.style.width).toBe('264px')
    expect(shell?.getAttribute('aria-hidden')).toBe('false')
    expect(shell?.querySelector('.sidebar-shell__resize-handle')).not.toBeNull()

    act(() => {
      useLayoutStore.getState().toggleSidebar()
    })

    expect(shell?.style.width).toBe('0px')
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
})
