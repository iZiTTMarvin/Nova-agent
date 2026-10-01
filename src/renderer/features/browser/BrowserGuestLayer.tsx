/**
 * 按宿主 guest 描述挂载 <webview>。会话页由主进程按隔离槽绑定；
 * 用户页共用持久 partition，由本层按自己创建的 webview 上报配对（主进程校验 partition）。
 * 位置跟随当前会话的浏览舞台；其它会话的 guest 只隐藏不卸载。
 */
import { useEffect, useRef, type ReactNode } from 'react'
import { useWorkspaceStore } from '../../stores/useWorkspaceStore'
import { selectBrowserPaneActive, useLayoutStore } from '../../stores/useLayoutStore'
import { BROWSER_ATTACH } from '../../../shared/ipc/channels'
import type { BrowserGuestMount } from '../../../shared/browser'
import { useBrowserStore } from './useBrowserStore'
import { guestShownInSession, pagesForSession, pickFocusedPage } from './sessionFilter'
import './BrowserGuestLayer.css'

interface WebviewGuest extends HTMLElement {
  getWebContentsId?: () => number
}

export function BrowserGuestLayer(): ReactNode {
  const sessionId = useWorkspaceStore((state) => state.currentSessionId)
  const currentMode = useWorkspaceStore((state) => state.currentMode)
  const isLearnSurface = currentMode === 'learn' && sessionId !== null
  const paneBrowserActive = useLayoutStore((state) => selectBrowserPaneActive(state, isLearnSurface))
  const snapshot = useBrowserStore((state) => state.snapshot)
  const guests = useBrowserStore((state) => state.guests)
  const focusedBrowserId = useBrowserStore((state) => state.focusedBrowserId)
  const layerRef = useRef<HTMLDivElement>(null)
  const guestsRef = useRef<Map<string, WebviewGuest>>(new Map())

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
    const panel = document.querySelector<HTMLElement>('.inspector-panel')
    const apply = (): void => {
      frame = 0
      const slot = document.querySelector<HTMLElement>('[data-browser-guest-slot]')
      const box = slot && paneBrowserActive ? slot.getBoundingClientRect() : null
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
      // transform 不触发 ResizeObserver，按真实面板动画逐帧跟随位置。
      if (panel?.getAnimations().some((animation) => animation.playState === 'running')) {
        frame = requestAnimationFrame(apply)
      }
    }
    const schedule = (): void => {
      if (frame !== 0) return
      frame = requestAnimationFrame(apply)
    }
    schedule()
    const transitionEvents = ['transitionrun', 'transitionend', 'transitioncancel'] as const
    for (const name of transitionEvents) panel?.addEventListener(name, schedule)
    let observedSlot: HTMLElement | null = null
    const ro = new ResizeObserver(schedule)
    const observeSlot = (): void => {
      const slot = panel?.querySelector<HTMLElement>('[data-browser-guest-slot]') ?? null
      if (slot === observedSlot) return
      ro.disconnect()
      observedSlot = slot
      if (slot) ro.observe(slot)
      schedule()
    }
    // 页签内容懒挂载，舞台出现或替换时重新绑定尺寸观察。
    const mo = new MutationObserver(observeSlot)
    if (panel) mo.observe(panel, { childList: true, subtree: true })
    observeSlot()
    window.addEventListener('resize', schedule)
    visualViewport?.addEventListener('resize', schedule)
    visualViewport?.addEventListener('scroll', schedule)
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame)
      for (const name of transitionEvents) panel?.removeEventListener(name, schedule)
      ro.disconnect()
      mo.disconnect()
      window.removeEventListener('resize', schedule)
      visualViewport?.removeEventListener('resize', schedule)
      visualViewport?.removeEventListener('scroll', schedule)
    }
  }, [paneBrowserActive, shown?.browserId, sessionId, overlayBlocksGuest, layoutWidth, layoutHeight])

  useEffect(() => {
    return () => {
      for (const mounted of guestsRef.current.values()) {
        mounted.remove()
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
  mounted: Map<string, WebviewGuest>,
  guests: readonly BrowserGuestMount[],
  shownBrowserId: string | null,
  overlayBlocksGuest: boolean
): void {
  const nextIds = new Set(guests.map((guest) => guest.browserId))
  for (const [browserId, current] of mounted) {
    if (!nextIds.has(browserId)) {
      current.remove()
      mounted.delete(browserId)
    }
  }

  for (const spec of guests) {
    const current = mounted.get(spec.browserId)
    if (!current) {
      const node = createGuestNode(spec)
      mounted.set(spec.browserId, node)
      layer.appendChild(node)
    }
    const node = mounted.get(spec.browserId)!
    const hide = overlayBlocksGuest || shownBrowserId !== spec.browserId
    node.classList.toggle('is-hidden', hide)
  }
}

function createGuestNode(spec: BrowserGuestMount): WebviewGuest {
  const node = document.createElement('webview') as WebviewGuest
  node.setAttribute('partition', spec.partition)
  // 存活页面的导航由主进程负责，src 只用于首次挂载。
  node.setAttribute('src', spec.src)
  node.setAttribute('allowpopups', 'true')
  node.setAttribute('data-browser-id', spec.browserId)
  node.className = 'browser-guest is-hidden'
  if (spec.sessionId === null) {
    // 用户页共用 partition，主进程无法按 partition 定位归属，这里指认配对
    let reported = false
    const report = (): void => {
      if (reported) return
      try {
        const webContentsId = node.getWebContentsId?.()
        if (typeof webContentsId !== 'number' || !Number.isInteger(webContentsId) || webContentsId < 1) return
        reported = true
        void window.api.invoke(BROWSER_ATTACH, { browserId: spec.browserId, webContentsId })
      } catch {
        reported = false
      }
    }
    node.addEventListener('did-attach', report)
    node.addEventListener('dom-ready', report)
  }
  return node
}
