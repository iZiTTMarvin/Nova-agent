// @vitest-environment jsdom

import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ContentTopBar } from '../../../src/renderer/components/ContentTopBar'
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

describe('ContentTopBar 删除会话错误反馈', () => {
  beforeEach(() => {
    vi.clearAllMocks()
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
        createdAt: 1,
        updatedAt: 1,
        messageCount: 0,
        title: '会话A',
        pinned: false
      }]
    })
  })

  it('删除被主进程拒绝时展示错误对话框，不静默关闭', async () => {
    let dialogCalls = 0
    mockInvoke.mockImplementation(async (channel: string) => {
      if (channel === 'dialog:confirm') {
        dialogCalls += 1
        // 第一次是删除确认（确认删除），第二次是错误提示（直接返回）
        return dialogCalls === 1 ? 1 : 0
      }
      if (channel === 'workspace:delete-session') {
        throw new Error('该会话或其子任务的 Agent 正在运行，请先停止再删除')
      }
      return false
    })

    const renderer = renderDom(<ContentTopBar />)
    act(() => {
      renderer.container
        .querySelector<HTMLButtonElement>('[aria-label="当前会话操作"]')
        ?.click()
    })
    const deleteItem = Array.from(
      renderer.container.querySelectorAll<HTMLButtonElement>('button')
    ).find(btn => btn.textContent?.trim() === '删除')
    expect(deleteItem).not.toBeNull()

    act(() => {
      deleteItem!.click()
    })
    // 组件链路经过动态 import（useWorkspaceStore / workspaceDispatcher），
    // 首轮模块求值需要超过一个宏任务，等待足够时间让整条 promise 链落定
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 50))
    })
    const errorDialogs = mockInvoke.mock.calls.filter(
      ([channel, opts]) =>
        channel === 'dialog:confirm' &&
        typeof opts === 'object' &&
        opts !== null &&
        (opts as { type?: string }).type === 'error'
    )
    expect(errorDialogs).toHaveLength(1)
    expect((errorDialogs[0][1] as { message?: string }).message).toContain('请先停止再删除')
    renderer.unmount()
  })

  it('删除成功后不弹错误框（主路径不回归）', async () => {
    mockInvoke.mockImplementation(async (channel: string) => {
      if (channel === 'dialog:confirm') return 1
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

    const renderer = renderDom(<ContentTopBar />)
    act(() => {
      renderer.container
        .querySelector<HTMLButtonElement>('[aria-label="当前会话操作"]')
        ?.click()
    })
    const deleteItem = Array.from(
      renderer.container.querySelectorAll<HTMLButtonElement>('button')
    ).find(btn => btn.textContent?.trim() === '删除')
    act(() => {
      deleteItem!.click()
    })
    // 与拒绝用例同一等待策略：跨动态 import 的整条 promise 链落定
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 50))
    })

    const errorDialogs = mockInvoke.mock.calls.filter(
      ([channel, opts]) =>
        channel === 'dialog:confirm' &&
        typeof opts === 'object' &&
        opts !== null &&
        (opts as { type?: string }).type === 'error'
    )
    expect(errorDialogs).toHaveLength(0)
    expect(
      mockInvoke.mock.calls.some(([channel]) => channel === 'workspace:delete-session')
    ).toBe(true)
    renderer.unmount()
  })
})
