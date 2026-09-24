/**
 * webContents guest 的窄适配：Host 只通过此面操作页面，测试可注入假对象。
 */
import { webContents, type WebContents } from 'electron'

export type GuestWindowOpenHandler = (details: { url: string }) => { action: 'deny' }

export type BrowserGuestEvent =
  | 'destroyed'
  | 'render-process-gone'
  | 'will-navigate'
  | 'did-navigate'
  | 'did-navigate-in-page'
  | 'did-start-loading'
  | 'did-stop-loading'
  | 'did-fail-load'
  | 'page-title-updated'
  | 'page-favicon-updated'

export interface BrowserGuestImage {
  toPNG(): Buffer
  getSize(): { readonly width: number; readonly height: number }
}

export interface BrowserGuestClip {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface BrowserGuestDebugger {
  isAttached(): boolean
  attach(protocol: string): void
  detach(): void
  sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown>
  on(event: 'detach', listener: () => void): void
  on(event: 'message', listener: (method: string, params: unknown) => void): void
  off(event: 'detach', listener: () => void): void
  off(event: 'message', listener: (method: string, params: unknown) => void): void
}

export interface BrowserGuestContents {
  readonly id: number
  getType(): string
  isDestroyed(): boolean
  isCrashed(): boolean
  getURL(): string
  getTitle(): string
  isLoading(): boolean
  loadURL(url: string): Promise<void>
  goBack(): void
  goForward(): void
  historyTarget(direction: 'back' | 'forward'): string | null
  reload(): void
  stop(): void
  capturePage(clip?: BrowserGuestClip): Promise<BrowserGuestImage>
  setWindowOpenHandler(handler: GuestWindowOpenHandler): void
  debugger: BrowserGuestDebugger
  on(event: BrowserGuestEvent, listener: (...args: unknown[]) => void): void
  off(event: BrowserGuestEvent, listener: (...args: unknown[]) => void): void
}

export function lookupElectronGuest(id: number): BrowserGuestContents | undefined {
  const guest = webContents.fromId(id)
  if (!guest) return undefined
  return wrapElectronGuest(guest)
}

function wrapDebugger(guest: WebContents): BrowserGuestDebugger {
  const detachListeners = new Map<() => void, () => void>()
  const messageListeners = new Map<
    (method: string, params: unknown) => void,
    (event: unknown, method: string, params: unknown) => void
  >()
  return {
    isAttached: () => {
      try {
        return guest.debugger.isAttached()
      } catch {
        return false
      }
    },
    attach: (protocol) => {
      guest.debugger.attach(protocol)
    },
    detach: () => {
      guest.debugger.detach()
    },
    sendCommand: (method, params) => guest.debugger.sendCommand(method, params),
    on: (event, listener) => {
      if (event === 'detach') {
        const detachListener = listener as () => void
        const wrapped = (): void => {
          detachListener()
        }
        detachListeners.set(detachListener, wrapped)
        guest.debugger.on('detach', wrapped)
        return
      }
      const messageListener = listener as (method: string, params: unknown) => void
      const wrapped = (_event: unknown, method: string, params: unknown): void => {
        messageListener(method, params)
      }
      messageListeners.set(messageListener, wrapped)
      guest.debugger.on('message', wrapped)
    },
    off: (event, listener) => {
      if (event === 'detach') {
        const detachListener = listener as () => void
        const wrapped = detachListeners.get(detachListener)
        if (!wrapped) return
        guest.debugger.off('detach', wrapped)
        detachListeners.delete(detachListener)
        return
      }
      const messageListener = listener as (method: string, params: unknown) => void
      const wrapped = messageListeners.get(messageListener)
      if (!wrapped) return
      guest.debugger.off('message', wrapped)
      messageListeners.delete(messageListener)
    }
  }
}

export function wrapElectronGuest(guest: WebContents): BrowserGuestContents {
  return {
    id: guest.id,
    getType: () => guest.getType(),
    isDestroyed: () => guest.isDestroyed(),
    isCrashed: () => {
      try {
        return guest.isCrashed()
      } catch {
        return true
      }
    },
    getURL: () => guest.getURL(),
    getTitle: () => guest.getTitle(),
    isLoading: () => guest.isLoading(),
    loadURL: (url) => guest.loadURL(url),
    goBack: () => {
      if (guest.navigationHistory.canGoBack()) guest.navigationHistory.goBack()
    },
    goForward: () => {
      if (guest.navigationHistory.canGoForward()) guest.navigationHistory.goForward()
    },
    historyTarget: (direction) => {
      const history = guest.navigationHistory
      const index = history.getActiveIndex() + (direction === 'back' ? -1 : 1)
      return history.getAllEntries()[index]?.url ?? null
    },
    reload: () => guest.reload(),
    stop: () => guest.stop(),
    setWindowOpenHandler: (handler) => {
      guest.setWindowOpenHandler((details) => handler({ url: details.url }))
    },
    capturePage: async (clip) => {
      const image = clip
        ? await guest.capturePage({
            x: Math.round(clip.x),
            y: Math.round(clip.y),
            width: Math.round(clip.width),
            height: Math.round(clip.height)
          })
        : await guest.capturePage()
      return {
        toPNG: () => image.toPNG(),
        getSize: () => image.getSize()
      }
    },
    debugger: wrapDebugger(guest),
    on: (event, listener) => {
      guest.on(event as Parameters<WebContents['on']>[0], listener as never)
    },
    off: (event, listener) => {
      guest.off(event as Parameters<WebContents['off']>[0], listener as never)
    }
  }
}
