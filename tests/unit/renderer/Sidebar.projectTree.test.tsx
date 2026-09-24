// @vitest-environment jsdom

import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Sidebar } from '../../../src/renderer/components/Sidebar'
import { resetAgentStoreForTests } from '../../../src/renderer/stores/useAgentStore'
import { resetChatStoreForTests, useChatStore } from '../../../src/renderer/stores/useChatStore'
import { resetSettingsStoreForTests, useSettingsStore } from '../../../src/renderer/stores/useSettingsStore'
import { resetCodeIndexStoreForTests } from '../../../src/renderer/stores/useCodeIndexStore'
import { resetLayoutStoreForTests } from '../../../src/renderer/stores/useLayoutStore'
import type { Session } from '../../../src/shared/session/types'
import { act, renderDom } from './renderDom'

vi.mock('../../../src/renderer/components/Icons', () => ({
  NovaLogo: () => null,
  FolderIcon: () => null,
  SettingsIcon: () => null,
  PlusIcon: () => null,
  PinIcon: () => null,
  PanelLeftIcon: () => null,
  SearchIcon: () => null,
  ClockIcon: () => null,
  FilterIcon: () => null,
  PuzzleIcon: () => null,
  ChevronDownIcon: () => null,
  TerminalIcon: () => null
}))

vi.mock('@astryxdesign/core/SideNav', () => ({
  SideNav: ({ children }: { children?: React.ReactNode }) => (
    <div data-testid="sidenav">{children}</div>
  ),
  SideNavHeading: () => null,
  SideNavItem: () => null,
  SideNavSection: ({ children, title }: { children?: React.ReactNode; title?: string }) => (
    <div data-section-title={title}>{children}</div>
  )
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

vi.mock('@astryxdesign/core/DropdownMenu', () => ({
  DropdownMenu: ({ children, isMenuOpen }: { children?: React.ReactNode; isMenuOpen?: boolean }) => (
    <div data-testid="dropdown-menu">{isMenuOpen ? children : null}</div>
  ),
  DropdownMenuItem: ({ label, onClick }: { label: string; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>{label}</button>
  )
}))

const sampleSession: Session = {
  id: 'sess-1',
  kind: 'primary',
  workspaceRoot: 'D:/test-workspace',
  mode: 'default',
  createdAt: 1,
  updatedAt: 2,
  messageCount: 1,
  title: 'Test Session'
}

function hover(element: Element, entering: boolean): void {
  act(() => {
    const related = document.body
    if (entering) {
      element.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: related }))
      element.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, relatedTarget: related }))
    } else {
      element.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: related }))
      element.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true, relatedTarget: related }))
    }
  })
}

describe('Sidebar 项目树交互与悬浮窗优化', () => {
  const originalApi = window.api

  beforeEach(() => {
    vi.useFakeTimers()
    resetChatStoreForTests()
    resetSettingsStoreForTests()
    resetAgentStoreForTests()
    resetCodeIndexStoreForTests()
    resetLayoutStoreForTests()
    window.api = {
      invoke: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(() => () => {}),
      removeAllListeners: vi.fn()
    } as never
  })

  afterEach(() => {
    vi.useRealTimers()
    window.api = originalApi
  })

  it('项目树标题字体加粗 (font-semibold)', () => {
    useChatStore.setState({ sessions: [sampleSession], currentSessionId: sampleSession.id })
    useSettingsStore.setState({ currentProject: 'D:/test-workspace' })

    const renderer = renderDom(<Sidebar />)
    const headerTitle = renderer.container.querySelector('.sidebar-project-header .font-semibold')

    expect(headerTitle).toBeTruthy()
    expect(headerTitle?.textContent).toContain('test-workspace')
    renderer.unmount()
  })

  it('项目行包含加号新建会话按钮，点击触发 createNewSession', () => {
    const createNewSession = vi.fn().mockResolvedValue(undefined)
    useChatStore.setState({
      sessions: [sampleSession],
      currentSessionId: sampleSession.id,
      createNewSession
    })
    useSettingsStore.setState({ currentProject: 'D:/test-workspace' })

    const renderer = renderDom(<Sidebar />)
    const addBtn = renderer.container.querySelector<HTMLButtonElement>('.sidebar-project-add-btn')
    expect(addBtn).toBeTruthy()
    expect(addBtn?.getAttribute('title')).toBe('在此项目下新建会话')

    act(() => {
      addBtn?.click()
    })

    expect(createNewSession).toHaveBeenCalledWith('D:/test-workspace')
    renderer.unmount()
  })

  it('会话异步到达后首次点击项目树即切换展开态', () => {
    const renderer = renderDom(<Sidebar />)
    act(() => {
      useChatStore.setState({ sessions: [sampleSession], currentSessionId: sampleSession.id })
      useSettingsStore.setState({ currentProject: 'D:/test-workspace' })
    })

    const header = renderer.container.querySelector<HTMLElement>('.sidebar-project-header')
    expect(header).toBeTruthy()
    expect(renderer.container.querySelectorAll('.sidebar-session-row').length).toBeGreaterThan(0)

    act(() => {
      header?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(renderer.container.querySelectorAll('.sidebar-session-row').length).toBe(0)

    act(() => {
      header?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(renderer.container.querySelectorAll('.sidebar-session-row').length).toBeGreaterThan(0)
    renderer.unmount()
  })

  it('hover 超过 1 秒钟才出现信息悬浮窗，悬浮窗内路径可点击并调用 workspace:open-directory', async () => {
    useChatStore.setState({ sessions: [sampleSession], currentSessionId: sampleSession.id })
    useSettingsStore.setState({ currentProject: 'D:/test-workspace' })

    const renderer = renderDom(<Sidebar />)
    const header = renderer.container.querySelector<HTMLElement>('.sidebar-project-header')
    expect(header).toBeTruthy()

    // 模拟鼠标移入
    hover(header!, true)

    // 500ms 后不应出现悬浮窗（优化后要求超过 1 秒钟）
    act(() => {
      vi.advanceTimersByTime(500)
    })
    expect(document.querySelector('.sidebar-project-popover')).toBeNull()

    // 达到 1000ms 后出现悬浮窗
    act(() => {
      vi.advanceTimersByTime(500)
    })
    const popover = document.querySelector('.sidebar-project-popover')
    expect(popover).toBeTruthy()
    expect(popover?.textContent).toContain('test-workspace')
    expect(popover?.textContent).toContain('1 个任务')
    expect(popover?.textContent).toContain('D:/test-workspace')

    // 点击路径打开项目根目录
    const pathBtn = popover?.querySelector<HTMLElement>('.sidebar-project-popover__path')
    expect(pathBtn).toBeTruthy()

    act(() => {
      pathBtn?.click()
    })

    expect(window.api.invoke).toHaveBeenCalledWith('workspace:open-directory', {
      path: 'D:/test-workspace'
    })

    renderer.unmount()
  })
})
