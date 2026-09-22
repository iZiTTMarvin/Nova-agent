/**
 * 按宿主 guest 描述挂载 <webview>，did-attach 用页面所属 sessionId 上报。
 * 位置跟随当前会话的浏览舞台；其它会话的 guest 只隐藏不卸载。
 */
import { useEffect, useRef, type ReactNode } from 'react'
import { useWorkspaceStore } from '../../stores/useWorkspaceStore'
import { useLayoutStore } from '../../stores/useLayoutStore'
import { BROWSER_ATTACH } from '../../../shared/ipc/channels'
import type { BrowserGuestMount } from '../../../shared/browser'
import { useBrowserStore } from './useBrowserStore'
import { guestShownInSession, pagesForSession, pickFocusedPage } from './sessionFilter'
import './BrowserGuestLayer.css'

interface WebviewGuest extends HTMLElement {
  getWebContentsId: () => number
  getURL?: () => string
}

function readGuestUrl(node: WebviewGuest): string {
  try {
    return node.getURL?.() ?? ''
  } catch {
    return ''
  }
}

export function BrowserGuestLayer(): ReactNode {
  const sessionId = useWorkspaceStore((state) => state.currentSessionId)
  const surfaceOpen = useLayoutStore((state) => state.browserSurfaceOpen)
  const snapshot = useBrowserStore((state) => state.snapshot)
  const guests = useBrowserStore((state) => state.guests)
  const focusedBrowserId = useBrowserStore((state) => state.focusedBrowserId)
  const layerRef = useRef<HTMLDivElement>(null)
  const guestsRef = useRef<Map<string, { spec: BrowserGuestMount; node: WebviewGuest }>>(new Map())

  const pages = pagesForSession(snapshot, sessionId)
  const focused = pickFocusedPage(pages, focusedBrowserId, snapshot?.activeBrowserId ?? null)
  const shown = guestShownInSession(guests?.guests ?? [], sessionId, focused?.browserId ?? null)
  const overlayBlocksGuest = Boolean(focused?.loadError)
  const layoutWidth = shown?.layoutWidth ?? null
  const layoutHeight = shown?.layoutHeight ?? null

  useEffect(() => {
    const layer = layerRef.current
    if (!layer) return
    reconcileGuests(
      layer,
      guestsRef.current,
      guests?.guests ?? [],
      shown?.browserId ?? null,
      overlayBlocksGuest
    )
  }, [guests, shown?.browserId, overlayBlocksGuest])

  useEffect(() => {
    const layer = layerRef.current
    if (!layer) return
    let frame = 0
    const apply = (): void => {
      frame = 0
      const slot = document.querySelector<HTMLElement>('[data-browser-guest-slot]')
      const box = slot && surfaceOpen ? slot.getBoundingClientRect() : null
      const visible = Boolean(box && shown && !overlayBlocksGuest && box.width > 1 && box.height > 1)
      layer.hidden = !visible
      if (!visible || !box) return
      layer.style.top = `${box.top}px`
      layer.style.left = `${box.left}px`
      const simulated = layoutWidth !== null && layoutHeight !== null && layoutWidth > 0 && layoutHeight > 0
      layer.style.width = `${simulated ? layoutWidth : box.width}px`
      layer.style.height = `${simulated ? layoutHeight : box.height}px`
      const guest = layer.querySelector<HTMLElement>('.browser-guest:not(.is-hidden)')
      if (guest) {
        guest.style.width = simulated ? `${layoutWidth}px` : '100%'
        guest.style.height = simulated ? `${layoutHeight}px` : '100%'
      }
    }
    const schedule = (): void => {
      if (frame !== 0) return
      frame = requestAnimationFrame(apply)
    }
    schedule()
    const slot = document.querySelector('[data-browser-guest-slot]')
    const ro = slot ? new ResizeObserver(schedule) : null
    if (slot && ro) ro.observe(slot)
    window.addEventListener('resize', schedule)
    visualViewport?.addEventListener('resize', schedule)
    visualViewport?.addEventListener('scroll', schedule)
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame)
      ro?.disconnect()
      window.removeEventListener('resize', schedule)
      visualViewport?.removeEventListener('resize', schedule)
      visualViewport?.removeEventListener('scroll', schedule)
    }
  }, [surfaceOpen, shown?.browserId, sessionId, overlayBlocksGuest, layoutWidth, layoutHeight])

  useEffect(() => {
    return () => {
      for (const mounted of guestsRef.current.values()) {
        mounted.node.remove()
      }
      guestsRef.current.clear()
    }
  }, [])

  return (
    <div
      ref={layerRef}
      className="browser-guest-layer"
      data-testid="browser-guest-layer"
      hidden
    />
  )
}

function reconcileGuests(
  layer: HTMLDivElement,
  mounted: Map<string, { spec: BrowserGuestMount; node: WebviewGuest }>,
  guests: readonly BrowserGuestMount[],
  shownBrowserId: string | null,
  overlayBlocksGuest: boolean
): void {
  const nextIds = new Set(guests.map((guest) => guest.browserId))
  for (const [browserId, current] of mounted) {
    if (!nextIds.has(browserId)) {
      current.node.remove()
      mounted.delete(browserId)
    }
  }

  for (const spec of guests) {
    const current = mounted.get(spec.browserId)
    if (!current) {
      const node = createGuestNode(spec)
      mounted.set(spec.browserId, { spec, node })
      layer.appendChild(node)
    } else {
      if (current.spec.src !== spec.src) {
        const live = readGuestUrl(current.node)
        if (live !== spec.src) current.node.setAttribute('src', spec.src)
      }
      current.spec = spec
    }
    const node = mounted.get(spec.browserId)!.node
    const hide = overlayBlocksGuest || shownBrowserId !== spec.browserId
    node.classList.toggle('is-hidden', hide)
  }
}

function createGuestNode(spec: BrowserGuestMount): WebviewGuest {
  const node = document.createElement('webview') as WebviewGuest
  node.setAttribute('partition', spec.partition)
  node.setAttribute('src', spec.src)
  node.setAttribute('allowpopups', 'true')
  node.setAttribute('data-browser-id', spec.browserId)
  node.className = 'browser-guest is-hidden'
  let reported = false

  const report = (): void => {
    if (reported) return
    try {
      const webContentsId = node.getWebContentsId()
      if (!Number.isInteger(webContentsId) || webContentsId < 1) return
      reported = true
      void window.api.invoke(BROWSER_ATTACH, {
        sessionId: spec.sessionId,
        browserId: spec.browserId,
        webContentsId
      })
    } catch {
      reported = false
    }
  }

  node.addEventListener('did-attach', report)
  node.addEventListener('dom-ready', report)
  return node
}
