/**
 * 浏览器快照的 renderer 投影。Host 仍是权威；本 store 只过滤展示并转发命令。
 */
import { create } from 'zustand'
import {
  BROWSER_CLOSE,
  BROWSER_GET_SNAPSHOT,
  BROWSER_GUEST_MOUNT,
  BROWSER_NAVIGATE,
  BROWSER_OPEN,
  BROWSER_CLAIM,
  BROWSER_RELEASE,
  BROWSER_SNAPSHOT
} from '../../../shared/ipc/channels'
import {
  BROWSER_MAX_USER_PAGES,
  BROWSER_USER_PAGE_CAP_MESSAGE,
  type BrowserGuestMountSnapshot,
  type BrowserNavigateAction,
  type BrowserSurfaceSnapshot
} from '../../../shared/browser'
import { useWorkspaceStore } from '../../stores/useWorkspaceStore'
import { useLayoutStore } from '../../stores/useLayoutStore'
import { composeBrowserNavigationUrl } from './addressInput'
import { pagesForSession, pickFocusedPage } from './sessionFilter'

interface BrowserStoreState {
  snapshot: BrowserSurfaceSnapshot | null
  guests: BrowserGuestMountSnapshot | null
  focusedBrowserId: string | null
  lastError: string | null
  composeNewPage: boolean
  applySnapshot: (snapshot: BrowserSurfaceSnapshot) => void
  applyGuestMount: (snapshot: BrowserGuestMountSnapshot) => void
  bindSessionSurface: (sessionId: string | null) => void
  focusPage: (browserId: string) => void
  beginNewPage: () => boolean
  openUrl: (rawUrl: string) => Promise<void>
  retryFocused: () => Promise<void>
  navigateFocused: (action: BrowserNavigateAction) => Promise<void>
  claimFocused: () => Promise<void>
  releaseFocused: () => Promise<void>
  closePage: (browserId: string) => Promise<void>
  closeFocused: () => Promise<void>
}

function currentSessionId(): string | null {
  return useWorkspaceStore.getState().currentSessionId
}

function isLearnSurfaceNow(): boolean {
  const workspace = useWorkspaceStore.getState()
  return workspace.currentMode === 'learn' && workspace.currentSessionId !== null
}

function openBrowserPane(): void {
  useLayoutStore.getState().openBrowserPane(isLearnSurfaceNow())
}

function pageIdsForSession(
  snapshot: BrowserSurfaceSnapshot | null,
  sessionId: string | null
): string[] {
  return pagesForSession(snapshot, sessionId).map((page) => page.browserId)
}

function userPageCount(snapshot: BrowserSurfaceSnapshot | null): number {
  return (snapshot?.pages.filter((page) => page.sessionId === null) ?? []).length
}

/**
 * 界面手动新开页面一律是用户作用域：不绑会话、走持久用户 profile，
 * AI 永远看不到；AI 打开的会话页面由工具面自己产生。
 */
async function openUserPage(
  url: string,
  set: (partial: Partial<BrowserStoreState>) => void
): Promise<void> {
  if (userPageCount(useBrowserStore.getState().snapshot) >= BROWSER_MAX_USER_PAGES) {
    set({ lastError: BROWSER_USER_PAGE_CAP_MESSAGE, composeNewPage: false })
    return
  }
  const opened = await window.api.invoke(BROWSER_OPEN, { sessionId: null, url })
  if (opened.status === 'applied') {
    openBrowserPane()
    set({ focusedBrowserId: opened.page.browserId, lastError: null, composeNewPage: false })
    return
  }
  set({ lastError: opened.detail, composeNewPage: false })
}

/** 失败/崩溃页重开跟随原页面作用域：会话页留在会话，用户页留在用户。 */
async function reopenPageWithScope(
  scope: string | null,
  url: string,
  set: (partial: Partial<BrowserStoreState>) => void
): Promise<void> {
  if (scope === null) {
    await openUserPage(url, set)
    return
  }
  const opened = await window.api.invoke(BROWSER_OPEN, { sessionId: scope, url })
  if (opened.status === 'applied') {
    openBrowserPane()
    set({ focusedBrowserId: opened.page.browserId, lastError: null, composeNewPage: false })
    return
  }
  set({ lastError: opened.detail, composeNewPage: false })
}

export const useBrowserStore = create<BrowserStoreState>((set, get) => ({
  snapshot: null,
  guests: null,
  focusedBrowserId: null,
  lastError: null,
  composeNewPage: false,

  applySnapshot: (snapshot) => {
    const sessionId = currentSessionId()
    // 初次同步（重载/启动后的第一次拉取）是恢复而非新页出现，不据此弹开面板
    const hadSnapshot = get().snapshot !== null
    const previousIds = new Set(pageIdsForSession(get().snapshot, sessionId))
    const pages = pagesForSession(snapshot, sessionId)
    const newcomers = pages.filter((page) => !previousIds.has(page.browserId))
    const focused = newcomers.at(-1)
      ?? pickFocusedPage(pages, get().focusedBrowserId, snapshot.activeBrowserId)
    const appeared = newcomers.length > 0
    set({
      snapshot,
      focusedBrowserId: focused?.browserId ?? null
    })
    if (appeared && hadSnapshot) openBrowserPane()
  },

  applyGuestMount: (guests) => {
    set({ guests })
  },

  bindSessionSurface: (sessionId) => {
    const pages = pagesForSession(get().snapshot, sessionId)
    const focused = pickFocusedPage(pages, null, get().snapshot?.activeBrowserId ?? null)
    set({ focusedBrowserId: focused?.browserId ?? null })
    // 会话自带的 AI 页面要让浏览器可见：覆盖启动/重载后会话异步恢复的场景。
    // 只有用户页时不自动弹开，避免每次切会话都打断当前布局。
    if (pages.some((page) => page.sessionId !== null)) openBrowserPane()
  },

  focusPage: (browserId) => {
    const sessionId = currentSessionId()
    const pages = pagesForSession(get().snapshot, sessionId)
    if (!pages.some((page) => page.browserId === browserId)) return
    set({ focusedBrowserId: browserId, composeNewPage: false })
  },

  beginNewPage: () => {
    if (userPageCount(get().snapshot) >= BROWSER_MAX_USER_PAGES) {
      set({ lastError: BROWSER_USER_PAGE_CAP_MESSAGE, composeNewPage: false })
      return false
    }
    set({ composeNewPage: true, lastError: null })
    return true
  },

  openUrl: async (rawUrl) => {
    const url = composeBrowserNavigationUrl(rawUrl)
    if (url === null) {
      set({ lastError: '请输入 http 或 https 地址' })
      return
    }
    openBrowserPane()
    const sessionId = currentSessionId()
    const pages = pagesForSession(get().snapshot, sessionId)
    const focused = pickFocusedPage(pages, get().focusedBrowserId, get().snapshot?.activeBrowserId ?? null)
    const openFresh = get().composeNewPage || !focused || focused.lifecycle === 'closing'
    if (focused && (focused.lifecycle === 'failed' || focused.lifecycle === 'crashed') && !get().composeNewPage) {
      await get().closePage(focused.browserId)
      await reopenPageWithScope(focused.sessionId, url, set)
      return
    }
    if (!openFresh && focused) {
      // 跟随聚焦页面自身的作用域导航：会话页留在会话，用户页留在用户
      const result = await window.api.invoke(BROWSER_NAVIGATE, {
        sessionId: focused.sessionId,
        browserId: focused.browserId,
        action: { kind: 'url', url }
      })
      if (result.status !== 'applied') set({ lastError: result.detail })
      else set({ lastError: null })
      return
    }
    await openUserPage(url, set)
  },

  retryFocused: async () => {
    const sessionId = currentSessionId()
    const pages = pagesForSession(get().snapshot, sessionId)
    const focused = pickFocusedPage(pages, get().focusedBrowserId, get().snapshot?.activeBrowserId ?? null)
    if (!focused) return
    if (focused.loadError && focused.lifecycle !== 'failed' && focused.lifecycle !== 'crashed') {
      await get().navigateFocused({ kind: 'reload' })
      return
    }
    const url = focused.url
    await get().closePage(focused.browserId)
    if (!url) return
    await reopenPageWithScope(focused.sessionId, url, set)
  },

  navigateFocused: async (action) => {
    const sessionId = currentSessionId()
    const pages = pagesForSession(get().snapshot, sessionId)
    const focused = pickFocusedPage(pages, get().focusedBrowserId, get().snapshot?.activeBrowserId ?? null)
    if (!focused) return
    const result = await window.api.invoke(BROWSER_NAVIGATE, {
      sessionId: focused.sessionId,
      browserId: focused.browserId,
      action
    })
    if (result.status !== 'applied') {
      set({ lastError: result.detail })
    }
  },

  claimFocused: async () => {
    const sessionId = currentSessionId()
    const pages = pagesForSession(get().snapshot, sessionId)
    const focused = pickFocusedPage(pages, get().focusedBrowserId, get().snapshot?.activeBrowserId ?? null)
    if (!focused || focused.sessionId === null) return
    const result = await window.api.invoke(BROWSER_CLAIM, {
      sessionId: focused.sessionId,
      browserId: focused.browserId
    })
    if (result.status !== 'applied') {
      set({ lastError: result.detail })
      return
    }
    set({ lastError: null })
  },

  releaseFocused: async () => {
    const sessionId = currentSessionId()
    const pages = pagesForSession(get().snapshot, sessionId)
    const focused = pickFocusedPage(pages, get().focusedBrowserId, get().snapshot?.activeBrowserId ?? null)
    if (!focused || focused.sessionId === null) return
    const result = await window.api.invoke(BROWSER_RELEASE, {
      sessionId: focused.sessionId,
      browserId: focused.browserId
    })
    if (result.status !== 'applied') {
      set({ lastError: result.detail })
      return
    }
    set({ lastError: null })
  },

  closePage: async (browserId) => {
    const sessionId = currentSessionId()
    const target = pagesForSession(get().snapshot, sessionId).find((page) => page.browserId === browserId)
    if (!target) return
    const result = await window.api.invoke(BROWSER_CLOSE, { sessionId: target.sessionId, browserId })
    // 宿主的关闭回执可能先于合帧快照到达；已退役的所属页面同样完成关闭意图。
    if (result.status === 'applied' || (result.status === 'not_applied' && result.code === 'page_closed')) {
      const pages = pagesForSession(get().snapshot, currentSessionId()).filter((page) => page.browserId !== browserId)
      set({
        focusedBrowserId: pages[0]?.browserId ?? null,
        lastError: null
      })
      // 最后一页关闭后浏览器页签留在原处显示空态，由用户决定切页签或关面板
      return
    }
    set({ lastError: result.detail })
  },

  closeFocused: async () => {
    const focusedId = get().focusedBrowserId
    if (!focusedId) return
    await get().closePage(focusedId)
  }
}))

export function startBrowserStore(): () => void {
  const pullSnapshot = (): void => {
    // null = 全量快照：界面本地过滤，无会话时也要恢复用户页
    void window.api.invoke(BROWSER_GET_SNAPSHOT, { sessionId: null }).then((result) => {
      if (result.status === 'applied') {
        useBrowserStore.getState().applySnapshot(result.snapshot)
      }
    })
  }
  const unsubSnapshot = window.api.on(BROWSER_SNAPSHOT, (data) => {
    useBrowserStore.getState().applySnapshot(data.snapshot)
  })
  const unsubGuests = window.api.on(BROWSER_GUEST_MOUNT, (data) => {
    useBrowserStore.getState().applyGuestMount(data.snapshot)
  })
  const unsubSession = useWorkspaceStore.subscribe((state, prev) => {
    if (state.currentSessionId === prev.currentSessionId) return
    useBrowserStore.getState().bindSessionSurface(state.currentSessionId)
    pullSnapshot()
  })
  useBrowserStore.getState().bindSessionSurface(currentSessionId())
  pullSnapshot()
  return () => {
    unsubSnapshot()
    unsubGuests()
    unsubSession()
  }
}

export function resetBrowserStoreForTests(): void {
  useBrowserStore.setState({
    snapshot: null,
    guests: null,
    focusedBrowserId: null,
    lastError: null,
    composeNewPage: false
  })
}
