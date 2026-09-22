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
  BROWSER_MAX_LIVE_PAGES,
  BROWSER_PAGE_CAP_MESSAGE,
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
  closePage: (browserId: string, options?: { keepSurface?: boolean }) => Promise<void>
  closeFocused: () => Promise<void>
}

function currentSessionId(): string | null {
  return useWorkspaceStore.getState().currentSessionId
}

function pageIdsForSession(
  snapshot: BrowserSurfaceSnapshot | null,
  sessionId: string | null
): string[] {
  return pagesForSession(snapshot, sessionId).map((page) => page.browserId)
}

async function openFreshPage(
  sessionId: string,
  url: string,
  set: (partial: Partial<BrowserStoreState>) => void
): Promise<void> {
  const pages = pagesForSession(useBrowserStore.getState().snapshot, sessionId)
  if (pages.length >= BROWSER_MAX_LIVE_PAGES) {
    set({ lastError: BROWSER_PAGE_CAP_MESSAGE, composeNewPage: false })
    return
  }
  const opened = await window.api.invoke(BROWSER_OPEN, { sessionId, url })
  if (opened.status === 'applied') {
    useLayoutStore.getState().openBrowserSurface()
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
    if (appeared) useLayoutStore.getState().openBrowserSurface()
  },

  applyGuestMount: (guests) => {
    set({ guests })
  },

  bindSessionSurface: (sessionId) => {
    const pages = pagesForSession(get().snapshot, sessionId)
    const focused = pickFocusedPage(pages, null, get().snapshot?.activeBrowserId ?? null)
    set({ focusedBrowserId: focused?.browserId ?? null })
    if (pages.length > 0) useLayoutStore.getState().openBrowserSurface()
    else useLayoutStore.getState().closeBrowserSurface()
  },

  focusPage: (browserId) => {
    const sessionId = currentSessionId()
    const pages = pagesForSession(get().snapshot, sessionId)
    if (!pages.some((page) => page.browserId === browserId)) return
    set({ focusedBrowserId: browserId, composeNewPage: false })
  },

  beginNewPage: () => {
    const sessionId = currentSessionId()
    const pages = pagesForSession(get().snapshot, sessionId)
    if (pages.length >= BROWSER_MAX_LIVE_PAGES) {
      set({ lastError: BROWSER_PAGE_CAP_MESSAGE, composeNewPage: false })
      return false
    }
    set({ composeNewPage: true, lastError: null })
    return true
  },

  openUrl: async (rawUrl) => {
    const sessionId = currentSessionId()
    if (!sessionId) {
      set({ lastError: '没有可绑定的会话' })
      return
    }
    const url = composeBrowserNavigationUrl(rawUrl)
    if (url === null) {
      set({ lastError: '请输入 http 或 https 地址' })
      return
    }
    useLayoutStore.getState().openBrowserSurface()
    const pages = pagesForSession(get().snapshot, sessionId)
    const focused = pickFocusedPage(pages, get().focusedBrowserId, get().snapshot?.activeBrowserId ?? null)
    const openFresh = get().composeNewPage || !focused || focused.lifecycle === 'closing'
    if (focused && (focused.lifecycle === 'failed' || focused.lifecycle === 'crashed') && !get().composeNewPage) {
      await get().closePage(focused.browserId, { keepSurface: true })
      await openFreshPage(sessionId, url, set)
      return
    }
    if (!openFresh && focused) {
      const result = await window.api.invoke(BROWSER_NAVIGATE, {
        sessionId,
        browserId: focused.browserId,
        action: { kind: 'url', url }
      })
      if (result.status !== 'applied') set({ lastError: result.detail })
      else set({ lastError: null })
      return
    }
    await openFreshPage(sessionId, url, set)
  },

  retryFocused: async () => {
    const sessionId = currentSessionId()
    const pages = pagesForSession(get().snapshot, sessionId)
    const focused = pickFocusedPage(pages, get().focusedBrowserId, get().snapshot?.activeBrowserId ?? null)
    if (!sessionId || !focused) return
    if (focused.loadError && focused.lifecycle !== 'failed' && focused.lifecycle !== 'crashed') {
      await get().navigateFocused({ kind: 'reload' })
      return
    }
    const url = focused.url
    await get().closePage(focused.browserId, { keepSurface: true })
    if (!url) return
    await openFreshPage(sessionId, url, set)
  },

  navigateFocused: async (action) => {
    const sessionId = currentSessionId()
    const focusedId = get().focusedBrowserId
    if (!sessionId || !focusedId) return
    const result = await window.api.invoke(BROWSER_NAVIGATE, {
      sessionId,
      browserId: focusedId,
      action
    })
    if (result.status !== 'applied') {
      set({ lastError: result.detail })
    }
  },

  claimFocused: async () => {
    const sessionId = currentSessionId()
    const focusedId = get().focusedBrowserId
    if (!sessionId || !focusedId) return
    const result = await window.api.invoke(BROWSER_CLAIM, {
      sessionId,
      browserId: focusedId
    })
    if (result.status !== 'applied') {
      set({ lastError: result.detail })
      return
    }
    set({ lastError: null })
  },

  releaseFocused: async () => {
    const sessionId = currentSessionId()
    const focusedId = get().focusedBrowserId
    if (!sessionId || !focusedId) return
    const result = await window.api.invoke(BROWSER_RELEASE, {
      sessionId,
      browserId: focusedId
    })
    if (result.status !== 'applied') {
      set({ lastError: result.detail })
      return
    }
    set({ lastError: null })
  },

  closePage: async (browserId, options) => {
    const sessionId = currentSessionId()
    if (!sessionId) return
    const result = await window.api.invoke(BROWSER_CLOSE, { sessionId, browserId })
    if (result.status === 'applied') {
      const pages = pagesForSession(get().snapshot, sessionId).filter((page) => page.browserId !== browserId)
      set({
        focusedBrowserId: pages[0]?.browserId ?? null,
        lastError: null
      })
      if (pages.length === 0 && !options?.keepSurface) {
        useLayoutStore.getState().closeBrowserSurface()
      }
      return
    }
    set({ lastError: result.detail })
  },

  closeFocused: async () => {
    const focusedId = get().focusedBrowserId
    if (!focusedId) {
      useLayoutStore.getState().closeBrowserSurface()
      return
    }
    await get().closePage(focusedId)
  }
}))

export function startBrowserStore(): () => void {
  const unsubSnapshot = window.api.on(BROWSER_SNAPSHOT, (data) => {
    useBrowserStore.getState().applySnapshot(data.snapshot)
  })
  const unsubGuests = window.api.on(BROWSER_GUEST_MOUNT, (data) => {
    useBrowserStore.getState().applyGuestMount(data.snapshot)
  })
  const unsubSession = useWorkspaceStore.subscribe((state, prev) => {
    if (state.currentSessionId === prev.currentSessionId) return
    useBrowserStore.getState().bindSessionSurface(state.currentSessionId)
    if (state.currentSessionId) {
      void window.api.invoke(BROWSER_GET_SNAPSHOT, { sessionId: state.currentSessionId }).then((result) => {
        if (result.status === 'applied') {
          useBrowserStore.getState().applySnapshot(result.snapshot)
        }
      })
    }
  })
  useBrowserStore.getState().bindSessionSurface(currentSessionId())
  const sessionId = currentSessionId()
  if (sessionId) {
    void window.api.invoke(BROWSER_GET_SNAPSHOT, { sessionId }).then((result) => {
      if (result.status === 'applied') {
        useBrowserStore.getState().applySnapshot(result.snapshot)
      }
    })
  }
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
