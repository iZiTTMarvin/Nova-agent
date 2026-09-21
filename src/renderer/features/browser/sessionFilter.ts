import type {
  BrowserGuestMount,
  BrowserPageProjection,
  BrowserSurfaceSnapshot
} from '../../../shared/browser'

export function pagesForSession(
  snapshot: BrowserSurfaceSnapshot | null,
  sessionId: string | null
): BrowserPageProjection[] {
  if (!snapshot || !sessionId) return []
  return snapshot.pages.filter((page) => page.sessionId === sessionId)
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
  if (!sessionId || !focusedBrowserId) return null
  return guests.find((guest) =>
    guest.sessionId === sessionId && guest.browserId === focusedBrowserId
  ) ?? null
}
