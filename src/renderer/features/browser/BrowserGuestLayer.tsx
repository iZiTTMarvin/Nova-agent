/**
 * 按宿主 guest 描述挂载 <webview>，did-attach 上报 webContentsId。
 * 位置不占用对话布局；应用浮层仍在其之上合成。
 */
import { useEffect, useRef, type ReactNode } from 'react'
import { useWorkspaceStore } from '../../stores/useWorkspaceStore'
import {
  BROWSER_ATTACH,
  BROWSER_GET_SNAPSHOT,
  BROWSER_GUEST_MOUNT
} from '../../../shared/ipc/channels'
import type { BrowserGuestMount } from '../../../shared/browser'
import './BrowserGuestLayer.css'

interface WebviewGuest extends HTMLElement {
  getWebContentsId: () => number
}

export function BrowserGuestLayer(): ReactNode {
  const sessionId = useWorkspaceStore((state) => state.currentSessionId)
  const layerRef = useRef<HTMLDivElement>(null)
  const guestsRef = useRef<Map<string, { spec: BrowserGuestMount; node: WebviewGuest }>>(new Map())

  useEffect(() => {
    const layer = layerRef.current
    if (!layer) return

    const unsub = window.api.on(BROWSER_GUEST_MOUNT, (data) => {
      reconcileGuests(layer, guestsRef.current, data.snapshot.guests, sessionId)
    })

    if (sessionId) {
      void window.api.invoke(BROWSER_GET_SNAPSHOT, { sessionId })
    }

    return () => {
      unsub()
      for (const mounted of guestsRef.current.values()) {
        mounted.node.remove()
      }
      guestsRef.current.clear()
    }
  }, [sessionId])

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
  sessionId: string | null
): void {
  layer.hidden = guests.length === 0

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
      mounted.set(spec.browserId, { spec, node: createGuestNode(spec, sessionId) })
      layer.appendChild(mounted.get(spec.browserId)!.node)
      continue
    }
    current.node.classList.toggle('is-hidden', !spec.visible)
    if (current.spec.src !== spec.src) {
      current.node.setAttribute('src', spec.src)
    }
    current.spec = spec
  }
}

function createGuestNode(spec: BrowserGuestMount, sessionId: string | null): WebviewGuest {
  const node = document.createElement('webview') as WebviewGuest
  node.setAttribute('partition', spec.partition)
  node.setAttribute('src', spec.src)
  node.setAttribute('allowpopups', 'true')
  node.setAttribute('data-browser-id', spec.browserId)
  node.className = spec.visible ? 'browser-guest' : 'browser-guest is-hidden'
  let reported = false

  const report = (): void => {
    if (reported || !sessionId) return
    try {
      const webContentsId = node.getWebContentsId()
      if (!Number.isInteger(webContentsId) || webContentsId < 1) return
      reported = true
      void window.api.invoke(BROWSER_ATTACH, {
        sessionId,
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
