// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BROWSER_ENGINE_CAPABILITIES, type BrowserPageProjection } from '../../../../src/shared/browser'
import { useBrowserStore, resetBrowserStoreForTests } from '../../../../src/renderer/features/browser/useBrowserStore'
import { useLayoutStore } from '../../../../src/renderer/stores/useLayoutStore'
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
    useLayoutStore.getState().openBrowserSurface()
  })

  it('已关闭回执先于最终快照时仍可关掉空面板', async () => {
    invoke.mockResolvedValue({ status: 'not_applied', code: 'page_closed', detail: '页面已关闭' })
    await useBrowserStore.getState().closeFocused()
    expect(useLayoutStore.getState().browserSurfaceOpen).toBe(false)
    expect(useBrowserStore.getState().focusedBrowserId).toBeNull()
    expect(useBrowserStore.getState().lastError).toBeNull()
  })

  it('权限拒绝不能被当成关闭成功', async () => {
    invoke.mockResolvedValue({ status: 'not_applied', code: 'not_owner', detail: '页面不属于当前会话' })
    await useBrowserStore.getState().closeFocused()
    expect(useLayoutStore.getState().browserSurfaceOpen).toBe(true)
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
    expect(useLayoutStore.getState().browserSurfaceOpen).toBe(true)
    expect(useBrowserStore.getState().focusedBrowserId).toBe('browser-b')
    expect(useBrowserStore.getState().lastError).toBeNull()
  })
})
