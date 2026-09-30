import type {
  BrowserGuestMount,
  BrowserPageProjection,
  BrowserSurfaceSnapshot
} from '../../../shared/browser'

/** 界面可见页面 = 当前会话的页面 + 用户作用域页面（不随会话切换消失）。 */
export function pagesForSession(
  snapshot: BrowserSurfaceSnapshot | null,
  sessionId: string | null
): BrowserPageProjection[] {
  if (!snapshot) return []
  return snapshot.pages.filter((page) => page.sessionId === null || page.sessionId === sessionId)
}

export function pickFocusedPage(
  pages: readonly BrowserPageProjection[],
  focusedBrowserId: string | null,
  activeBrowserId: string | null
): BrowserPageProjection | null {
  if (pages.length === 0) return null
  const focused = focusedBrowserId
    ? pages.find((page) => page.browserId === focusedBrowserId)
    : undefined
  if (focused) return focused
  const active = activeBrowserId
    ? pages.find((page) => page.browserId === activeBrowserId)
    : undefined
  if (active) return active
  return pages[0] ?? null
}

export function guestShownInSession(
  guests: readonly BrowserGuestMount[],
  sessionId: string | null,
  focusedBrowserId: string | null
): BrowserGuestMount | null {
  if (!focusedBrowserId) return null
  return guests.find((guest) =>
    (guest.sessionId === null || guest.sessionId === sessionId)
    && guest.browserId === focusedBrowserId
  ) ?? null
}
