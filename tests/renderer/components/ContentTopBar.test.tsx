// @vitest-environment jsdom

import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ContentTopBar, GlassSessionHeader } from '../../../src/renderer/components/ContentTopBar'
import { InspectorToggleButton } from '../../../src/renderer/features/inspector/InspectorToggleButton'
import {
  resetLayoutStoreForTests,
  useLayoutStore
} from '../../../src/renderer/stores/useLayoutStore'
import {
  resetChatStoreForTests,
  useChatStore
} from '../../../src/renderer/stores/useChatStore'
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
const { mockConfirm } = vi.hoisted(() => ({ mockConfirm: vi.fn() }))
vi.mock('../../../src/renderer/features/confirm/confirmDialog', () => ({
  confirmDialog: mockConfirm
}))

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

  it('面板开合按钮是常驻单实例：点击开合、自身始终在场且 aria-expanded 同步', () => {
    const renderer = renderDom(<InspectorToggleButton />)
    const selector = 'button[aria-label="审阅、文件与浏览面板"]'
    const btn = renderer.container.querySelector<HTMLButtonElement>(selector)
    expect(btn).not.toBeNull()
    expect(btn?.getAttribute('aria-expanded')).toBe('false')

    act(() => {
      btn?.click()
    })
    expect(useLayoutStore.getState().inspectorOpen).toBe(true)
    // 同一元素不换实例：不存在“收起态一个、展开态另一个”的互斥渲染
    const openBtn = renderer.container.querySelector<HTMLButtonElement>(selector)
    expect(openBtn).toBe(btn)
    expect(openBtn?.getAttribute('aria-expanded')).toBe('true')

    act(() => {
      openBtn?.click()
    })
    expect(useLayoutStore.getState().inspectorOpen).toBe(false)
    expect(renderer.container.querySelector(selector)).toBe(btn)
    renderer.unmount()
  })

  it('浏览器共用右侧面板入口，快捷键切到浏览页再收起', () => {
    const renderer = renderDom(<ContentTopBar />)
    const btn = renderer.container.querySelector<HTMLButtonElement>(
      '[aria-label="在 Nova 中打开"]'
    )
    expect(btn).toBeNull()
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, altKey: true }))
    })
    expect(useLayoutStore.getState()).toMatchObject({
      inspectorOpen: true,
      inspectorTab: 'browser',
      inspectorWidth: 420
    })
    // 浏览器是面板页签：再次点击收起面板而不是停留在打开状态
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, altKey: true }))
    })
    expect(useLayoutStore.getState().inspectorOpen).toBe(false)
    renderer.unmount()
  })

  it('内容区顶栏不渲染侧栏开关：开关是窗口左上角常驻实例，开合两态均不在此行', () => {
    const renderer = renderDom(<ContentTopBar />)
    expect(
      renderer.container.querySelector('[aria-label="展开会话导航"]')
    ).toBeNull()
    expect(
      renderer.container.querySelector('[aria-label="折叠会话导航"]')
    ).toBeNull()

    act(() => {
      useLayoutStore.getState().toggleSidebar()
    })
    expect(
      renderer.container.querySelector('[aria-label="展开会话导航"]')
    ).toBeNull()
    renderer.unmount()
  })
})

describe('ContentTopBar 删除会话错误反馈', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockConfirm.mockReset()
    resetLayoutStoreForTests()
    resetChatStoreForTests()
    mockInvoke.mockResolvedValue(false)
    Object.assign(window, {
      api: {
        invoke: mockInvoke,
        on: vi.fn(() => () => {}),
        removeAllListeners: vi.fn()
      }
    })
    useChatStore.setState({
      currentSessionId: 'sessA',
      sessions: [{
        id: 'sessA',
        kind: 'primary',
        workspaceRoot: '/ws',
        mode: 'default',
        permissionMode: 'auto',
        createdAt: 1,
        updatedAt: 1,
        messageCount: 0,
        title: '会话A',
        pinned: false
      }]
    })
  })

  it('删除被主进程拒绝时展示错误对话框，不静默关闭', async () => {
    // 第一次是删除确认（确认删除），第二次是错误提示（直接返回）
    mockConfirm.mockResolvedValueOnce(1).mockResolvedValueOnce(0)
    mockInvoke.mockImplementation(async (channel: string) => {
      if (channel === 'workspace:delete-session') {
        throw new Error('该会话或其子任务的 Agent 正在运行，请先停止再删除')
      }
      return false
    })

    const renderer = renderDom(<GlassSessionHeader />)
    act(() => {
      renderer.container
        .querySelector<HTMLButtonElement>('[aria-label="当前会话操作"]')
        ?.click()
    })
    const deleteItem = Array.from(
      renderer.container.querySelectorAll<HTMLElement>('[role="menuitem"]')
    ).find(item => item.textContent?.trim() === '删除')
    expect(deleteItem).not.toBeNull()

    act(() => {
      deleteItem!.click()
    })
    // 组件链路经过动态 import（useWorkspaceStore / workspaceDispatcher），
    // 首轮模块求值需要超过一个宏任务，等待足够时间让整条 promise 链落定
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 50))
    })
    const errorDialogs = mockConfirm.mock.calls.filter(([opts]) => opts.type === 'error')
    expect(errorDialogs).toHaveLength(1)
    expect(errorDialogs[0][0].message).toContain('请先停止再删除')
    renderer.unmount()
  })

  it('删除成功后不弹错误框（主路径不回归）', async () => {
    mockConfirm.mockResolvedValue(1)
    mockInvoke.mockImplementation(async (channel: string) => {
      if (channel === 'workspace:delete-session') {
        return {
          currentSessionId: null,
          currentProjectPath: '/ws',
          currentMode: 'default',
          availableSessions: [],
          messagesRevision: 0
        }
      }
      return false
    })

    const renderer = renderDom(<GlassSessionHeader />)
    act(() => {
      renderer.container
        .querySelector<HTMLButtonElement>('[aria-label="当前会话操作"]')
        ?.click()
    })
    const deleteItem = Array.from(
      renderer.container.querySelectorAll<HTMLElement>('[role="menuitem"]')
    ).find(item => item.textContent?.trim() === '删除')
    act(() => {
      deleteItem!.click()
    })
    // 与拒绝用例同一等待策略：跨动态 import 的整条 promise 链落定
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 50))
    })

    const errorDialogs = mockConfirm.mock.calls.filter(([opts]) => opts.type === 'error')
    expect(errorDialogs).toHaveLength(0)
    expect(
      mockInvoke.mock.calls.some(([channel]) => channel === 'workspace:delete-session')
    ).toBe(true)
    renderer.unmount()
  })
})
