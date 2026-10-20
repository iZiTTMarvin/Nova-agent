// @vitest-environment jsdom

import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Sidebar } from '../../../src/renderer/components/Sidebar'
import { resetAgentStoreForTests } from '../../../src/renderer/stores/useAgentStore'
import { resetChatStoreForTests, useChatStore } from '../../../src/renderer/stores/useChatStore'
import { resetSettingsStoreForTests, useSettingsStore } from '../../../src/renderer/stores/useSettingsStore'
import { resetCodeIndexStoreForTests } from '../../../src/renderer/stores/useCodeIndexStore'
import { resetLayoutStoreForTests, useLayoutStore } from '../../../src/renderer/stores/useLayoutStore'
import type { PrimarySession, Session } from '../../../src/shared/session/types'
import { act, renderDom, waitFor } from './renderDom'

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
  TerminalIcon: () => null,
  CodeIcon: () => null,
  BookIcon: () => null
}))

vi.mock('@astryxdesign/core/SideNav', () => ({
  SideNav: ({
    topContent,
    children,
    footer
  }: {
    topContent?: React.ReactNode
    children?: React.ReactNode
    footer?: React.ReactNode
  }) => (
    <div data-testid="sidenav">
      {topContent}
      {children}
      {footer}
    </div>
  ),
  SideNavHeading: () => null,
  SideNavItem: () => null,
  SideNavSection: ({
    children,
    title,
    endContent
  }: {
    children?: React.ReactNode
    title?: string
    endContent?: React.ReactNode
  }) => (
    <div data-section-title={title}>
      {endContent}
      {children}
    </div>
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
  DropdownMenu: ({
    children,
    isMenuOpen,
    onOpenChange,
    button
  }: {
    children?: React.ReactNode
    isMenuOpen?: boolean
    onOpenChange?: (open: boolean) => void
    button?: { label?: string }
  }) => (
    <div data-testid="dropdown-menu">
      <button type="button" aria-label={button?.label} onClick={() => onOpenChange?.(!isMenuOpen)} />
      {isMenuOpen ? children : null}
    </div>
  ),
  DropdownMenuItem: ({ label, onClick }: { label: string; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>{label}</button>
  )
}))

const { mockConfirm } = vi.hoisted(() => ({ mockConfirm: vi.fn() }))
vi.mock('../../../src/renderer/features/confirm/confirmDialog', () => ({
  confirmDialog: mockConfirm
}))

const sampleSession: PrimarySession = {
  id: 'sess-1',
  kind: 'primary',
  workspaceRoot: 'D:/test-workspace',
  mode: 'default',
  permissionMode: 'auto',
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
  const mockInvoke = vi.fn()

  beforeEach(() => {
    vi.useFakeTimers()
    mockInvoke.mockReset()
    mockConfirm.mockReset()
    mockInvoke.mockResolvedValue(undefined)
    resetChatStoreForTests()
    resetSettingsStoreForTests()
    resetAgentStoreForTests()
    resetCodeIndexStoreForTests()
    resetLayoutStoreForTests()
    Object.assign(window, {
      api: {
        invoke: mockInvoke,
        on: vi.fn(() => () => {}),
        removeAllListeners: vi.fn()
      }
    })
  })

  afterEach(() => {
    vi.useRealTimers()
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

    expect(mockInvoke).toHaveBeenCalledWith('workspace:open-directory', {
      path: 'D:/test-workspace'
    })

    renderer.unmount()
  })

  it('置顶会话支持 Alt+ArrowDown / Alt+ArrowUp 键盘重排并持久化顺序', () => {
    const pinnedA: Session = { ...sampleSession, id: 'sess-a', title: 'Pinned A', pinned: true }
    const pinnedB: Session = { ...sampleSession, id: 'sess-b', title: 'Pinned B', pinned: true }
    useChatStore.setState({ sessions: [pinnedA, pinnedB], currentSessionId: pinnedA.id })
    useSettingsStore.setState({ currentProject: 'D:/test-workspace' })

    const renderer = renderDom(<Sidebar />)
    const pinnedSection = renderer.container.querySelector('[data-section-title="置顶"]')!
    const rows = pinnedSection.querySelectorAll<HTMLElement>('.sidebar-session-row')
    expect(rows).toHaveLength(2)
    expect(rows[0]?.getAttribute('title')).toContain('Pinned A')

    act(() => {
      rows[0]!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true, cancelable: true })
      )
    })

    expect(useLayoutStore.getState().pinnedSessionOrder).toEqual(['sess-b', 'sess-a'])
    const updatedRows = pinnedSection.querySelectorAll<HTMLElement>('.sidebar-session-row')
    expect(updatedRows[0]?.getAttribute('title')).toContain('Pinned B')

    renderer.unmount()
  })

  it('「搜索会话」位于「添加工作区」下方，点击后展开可直接输入与关闭的搜索栏，且不再展示冗余的过滤会话按钮', () => {
    const sessA: Session = { ...sampleSession, id: 'sess-a', title: '修复深色主题 Diff' }
    const sessB: Session = { ...sampleSession, id: 'sess-b', title: '重构侧边栏搜索' }
    useChatStore.setState({ sessions: [sessA, sessB], currentSessionId: sessA.id })
    useSettingsStore.setState({ currentProject: 'D:/test-workspace' })

    const renderer = renderDom(<Sidebar />)

    // 不再渲染「过滤会话」和顶栏「会话检索」按钮
    const allButtons = Array.from(renderer.container.querySelectorAll('button'))
    expect(allButtons.some(btn => (btn.getAttribute('aria-label') ?? '').includes('过滤会话'))).toBe(false)
    expect(allButtons.some(btn => (btn.getAttribute('aria-label') ?? '').includes('会话检索'))).toBe(false)

    // 「搜索会话」按钮存在，点击后切换为搜索输入框
    const searchActionBtn = allButtons.find(btn => (btn.textContent ?? '').includes('搜索会话'))
    expect(searchActionBtn).toBeTruthy()

    act(() => {
      searchActionBtn?.click()
    })

    const searchInput = renderer.container.querySelector<HTMLInputElement>('.sidebar-search-bar__input')
    expect(searchInput).toBeTruthy()

    // 输入关键字过滤会话
    act(() => {
      const nativeValueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value'
      )?.set
      nativeValueSetter?.call(searchInput, '深色主题')
      searchInput?.dispatchEvent(new Event('input', { bubbles: true }))
    })

    const filteredRows = renderer.container.querySelectorAll<HTMLElement>('.sidebar-session-row')
    expect(filteredRows).toHaveLength(1)
    expect(filteredRows[0]?.getAttribute('title')).toContain('修复深色主题 Diff')

    // 点击关闭按钮清空并收起搜索栏，恢复完整会话列表
    const closeBtn = renderer.container.querySelector<HTMLButtonElement>('.sidebar-search-bar__close')
    expect(closeBtn).toBeTruthy()
    act(() => {
      closeBtn?.click()
    })

    expect(renderer.container.querySelector('.sidebar-search-bar__input')).toBeNull()
    expect(renderer.container.querySelectorAll('.sidebar-session-row')).toHaveLength(2)

    renderer.unmount()
  })

  it('搜索过滤期间删除项目，仍删除该项目下的全部会话', async () => {
    vi.useRealTimers()
    const sessA: Session = { ...sampleSession, id: 'sess-a', title: '修复深色主题 Diff' }
    const sessB: Session = { ...sampleSession, id: 'sess-b', title: '重构侧边栏搜索' }
    const deleteSession = vi.fn(async (_sessionId: string) => {})
    useChatStore.setState({ sessions: [sessA, sessB], currentSessionId: sessA.id, deleteSession })
    useSettingsStore.setState({ currentProject: 'D:/test-workspace' })
    mockConfirm.mockResolvedValue(1)

    const renderer = renderDom(<Sidebar />)
    const searchActionBtn = Array.from(renderer.container.querySelectorAll('button'))
      .find(btn => (btn.textContent ?? '').includes('搜索会话'))
    act(() => {
      searchActionBtn?.click()
    })
    const searchInput = renderer.container.querySelector<HTMLInputElement>('.sidebar-search-bar__input')
    act(() => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set?.call(searchInput, '深色主题')
      searchInput?.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(renderer.container.querySelectorAll('.sidebar-session-row')).toHaveLength(1)

    act(() => {
      renderer.container.querySelector<HTMLButtonElement>('button[aria-label="项目操作"]')?.click()
    })
    const deleteItem = Array.from(renderer.container.querySelectorAll('button'))
      .find(btn => btn.textContent === '删除')
    act(() => {
      deleteItem?.click()
    })

    await waitFor(() => deleteSession.mock.calls.length === 2)
    expect(mockConfirm).toHaveBeenCalledWith(expect.objectContaining({
      detail: expect.stringContaining('共 2 个任务')
    }))
    expect(deleteSession.mock.calls.map(([id]) => id).sort()).toEqual(['sess-a', 'sess-b'])

    renderer.unmount()
  })
})
