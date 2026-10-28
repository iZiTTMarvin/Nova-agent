// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BROWSER_ENGINE_CAPABILITIES, type BrowserPageProjection } from '../../../../src/shared/browser'
import { BROWSER_NAVIGATE, BROWSER_OPEN } from '../../../../src/shared/ipc/channels'
import { useBrowserStore, resetBrowserStoreForTests } from '../../../../src/renderer/features/browser/useBrowserStore'
import { selectBrowserPaneActive, useLayoutStore } from '../../../../src/renderer/stores/useLayoutStore'
import { useWorkspaceStore } from '../../../../src/renderer/stores/useWorkspaceStore'

const invoke = vi.fn()

function page(sessionId = 'session-a', browserId = 'browser-a'): BrowserPageProjection {
  return {
    browserId, generation: 1, documentEpoch: 1, sessionId,
    url: 'https://example.com', title: 'Example', loading: false, lifecycle: 'ready',
    control: { holder: 'none' }, capabilities: BROWSER_ENGINE_CAPABILITIES,
    faviconUrl: null, loadError: null, notice: null
  }
}

describe('浏览器关闭结果对账', () => {
  beforeEach(() => {
    invoke.mockReset()
    Object.assign(window, { api: { invoke } })
    resetBrowserStoreForTests()
    useWorkspaceStore.setState({ currentSessionId: 'session-a' })
    useBrowserStore.getState().applySnapshot({
      sequence: 1, pages: [page()], activeBrowserId: 'browser-a', maxLivePages: 2
    })
    useLayoutStore.getState().openBrowserPane(false)
  })

  it('已关闭回执先于最终快照时清空聚焦，浏览器页签留在原处', async () => {
    invoke.mockResolvedValue({ status: 'not_applied', code: 'page_closed', detail: '页面已关闭' })
    await useBrowserStore.getState().closeFocused()
    expect(useBrowserStore.getState().focusedBrowserId).toBeNull()
    expect(useBrowserStore.getState().lastError).toBeNull()
    // 浏览器是右侧面板的页签，最后一页关闭后不再自动收起面板
    expect(selectBrowserPaneActive(useLayoutStore.getState(), false)).toBe(true)
  })

  it('权限拒绝不能被当成关闭成功', async () => {
    invoke.mockResolvedValue({ status: 'not_applied', code: 'not_owner', detail: '页面不属于当前会话' })
    await useBrowserStore.getState().closeFocused()
    expect(useLayoutStore.getState().inspectorOpen).toBe(true)
    expect(useBrowserStore.getState().focusedBrowserId).toBe('browser-a')
    expect(useBrowserStore.getState().lastError).toBe('页面不属于当前会话')
  })

  it('关闭回执迟到时不关闭新会话的浏览器', async () => {
    let finish!: (result: { status: 'not_applied'; code: 'page_closed'; detail: string }) => void
    invoke.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const closing = useBrowserStore.getState().closeFocused()
    useWorkspaceStore.setState({ currentSessionId: 'session-b' })
    useBrowserStore.getState().applySnapshot({
      sequence: 2, pages: [page('session-b', 'browser-b')], activeBrowserId: 'browser-b', maxLivePages: 2
    })
    finish({ status: 'not_applied', code: 'page_closed', detail: '页面已关闭' })
    await closing
    expect(useLayoutStore.getState().inspectorOpen).toBe(true)
    expect(useBrowserStore.getState().focusedBrowserId).toBe('browser-b')
    expect(useBrowserStore.getState().lastError).toBeNull()
  })
})

describe('无会话的用户浏览', () => {
  beforeEach(() => {
    invoke.mockReset()
    Object.assign(window, { api: { invoke } })
    resetBrowserStoreForTests()
    useWorkspaceStore.setState({ currentSessionId: null })
    useLayoutStore.setState({ inspectorOpen: false, inspectorTab: 'review', learnInspectorOpen: false })
  })

  it('没有会话也能打开用户页：BROWSER_OPEN 携带 null 会话并展开面板', async () => {
    invoke.mockResolvedValue({
      status: 'applied',
      page: page(null, 'browser-user-1')
    })
    await useBrowserStore.getState().openUrl('example.com/docs')
    expect(invoke).toHaveBeenCalledWith(BROWSER_OPEN, { sessionId: null, url: 'https://example.com/docs' })
    expect(selectBrowserPaneActive(useLayoutStore.getState(), false)).toBe(true)
    expect(useBrowserStore.getState().focusedBrowserId).toBe('browser-user-1')
    expect(useBrowserStore.getState().lastError).toBeNull()
  })

  it('用户页不随会话切换消失：无会话时面板保持打开', () => {
    const userPage = page(null, 'browser-user-1')
    // 初次同步是恢复，不自动弹开面板
    useBrowserStore.getState().applySnapshot({
      sequence: 1, pages: [userPage, page('session-a', 'browser-a')], activeBrowserId: 'browser-a', maxLivePages: 2
    })
    expect(selectBrowserPaneActive(useLayoutStore.getState(), false)).toBe(false)
    useLayoutStore.getState().openBrowserPane(false)
    // 切到无会话：会话页不可见，用户页仍在，聚焦随用户页
    useBrowserStore.getState().bindSessionSurface(null)
    expect(selectBrowserPaneActive(useLayoutStore.getState(), false)).toBe(true)
    expect(useBrowserStore.getState().focusedBrowserId).toBe('browser-user-1')
    // 页面全部清空后聚焦回落为空；面板开合由用户掌握，不自动收起
    useBrowserStore.getState().applySnapshot({
      sequence: 2, pages: [], activeBrowserId: null, maxLivePages: 2
    })
    useBrowserStore.getState().bindSessionSurface(null)
    expect(useBrowserStore.getState().focusedBrowserId).toBeNull()
    expect(selectBrowserPaneActive(useLayoutStore.getState(), false)).toBe(true)
  })

  it('导航跟随聚焦页面自身的作用域', async () => {
    invoke.mockResolvedValue({ status: 'applied', page: page(null, 'browser-user-1') })
    useBrowserStore.getState().applySnapshot({
      sequence: 1, pages: [page(null, 'browser-user-1')], activeBrowserId: 'browser-user-1', maxLivePages: 2
    })
    await useBrowserStore.getState().openUrl('https://example.com/next')
    expect(invoke).toHaveBeenCalledWith(BROWSER_NAVIGATE, {
      sessionId: null,
      browserId: 'browser-user-1',
      action: { kind: 'url', url: 'https://example.com/next' }
    })
  })
})

describe('Agent 页面自动打开面板的跨会话恢复', () => {
  const closedLayout = { inspectorOpen: false, inspectorTab: 'review', learnInspectorOpen: false } as const

  function seedSnapshot(pages: BrowserPageProjection[], sequence = 1): void {
    useBrowserStore.getState().applySnapshot({
      sequence, pages, activeBrowserId: pages[0]?.browserId ?? null, maxLivePages: 2
    })
  }

  beforeEach(() => {
    invoke.mockReset()
    Object.assign(window, { api: { invoke } })
    resetBrowserStoreForTests()
    useWorkspaceStore.setState({ currentSessionId: 'session-b', currentMode: 'dev' })
    useLayoutStore.setState({ ...closedLayout, browserAutoOpenRestore: null })
    seedSnapshot([], 1)
  })

  it('会话 B 的 Agent 页自动打开面板，切回无页面的会话 A 恢复原布局', () => {
    seedSnapshot([page('session-b', 'browser-b')], 2)
    expect(selectBrowserPaneActive(useLayoutStore.getState(), false)).toBe(true)

    useWorkspaceStore.setState({ currentSessionId: 'session-a' })
    useBrowserStore.getState().bindSessionSurface('session-a')
    expect(useLayoutStore.getState().inspectorOpen).toBe(false)
    expect(useLayoutStore.getState().browserAutoOpenRestore).toBeNull()
    // 页面没有被销毁，切回会话 B 仍然可见
    expect(useBrowserStore.getState().snapshot?.pages.map((p) => p.browserId)).toEqual(['browser-b'])
    useWorkspaceStore.setState({ currentSessionId: 'session-b' })
    useBrowserStore.getState().bindSessionSurface('session-b')
    expect(selectBrowserPaneActive(useLayoutStore.getState(), false)).toBe(true)
    expect(useBrowserStore.getState().focusedBrowserId).toBe('browser-b')
  })

  it('自动打开前面板已在显示其他标签时，恢复回该标签', () => {
    useLayoutStore.setState({ inspectorOpen: true, inspectorTab: 'review' })
    seedSnapshot([page('session-b', 'browser-b')], 2)
    expect(selectBrowserPaneActive(useLayoutStore.getState(), false)).toBe(true)

    useBrowserStore.getState().bindSessionSurface('session-a')
    expect(useLayoutStore.getState().inspectorOpen).toBe(true)
    expect(useLayoutStore.getState().inspectorTab).toBe('review')
  })

  it('用户在自动打开后手动打开浏览器，切回无页面会话不收回', () => {
    seedSnapshot([page('session-b', 'browser-b')], 2)
    useLayoutStore.getState().openBrowserPane(false)
    useBrowserStore.getState().bindSessionSurface('session-a')
    expect(selectBrowserPaneActive(useLayoutStore.getState(), false)).toBe(true)
  })

  it('用户在自动打开后切到文件审阅标签，不被收回', () => {
    seedSnapshot([page('session-b', 'browser-b')], 2)
    useLayoutStore.getState().setInspectorTab('review')
    useBrowserStore.getState().bindSessionSurface('session-a')
    expect(useLayoutStore.getState().inspectorOpen).toBe(true)
    expect(useLayoutStore.getState().inspectorTab).toBe('review')
  })

  it('目标会话有用户页时保持面板，用户页跨会话保留', () => {
    seedSnapshot([page('session-b', 'browser-b'), page(null, 'browser-user')], 2)
    useBrowserStore.getState().bindSessionSurface('session-a')
    expect(selectBrowserPaneActive(useLayoutStore.getState(), false)).toBe(true)
    expect(useBrowserStore.getState().focusedBrowserId).toBe('browser-user')
  })

  it('初次快照是恢复而非新页出现，不弹开面板', () => {
    resetBrowserStoreForTests()
    seedSnapshot([page('session-b', 'browser-b')], 1)
    expect(useLayoutStore.getState().inspectorOpen).toBe(false)
    expect(useLayoutStore.getState().browserAutoOpenRestore).toBeNull()
  })
})
