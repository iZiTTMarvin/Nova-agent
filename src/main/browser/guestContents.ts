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
  | 'did-start-loading'
  | 'did-stop-loading'
  | 'page-title-updated'

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
  reload(): void
  stop(): void
  setWindowOpenHandler(handler: GuestWindowOpenHandler): void
  debugger: {
    isAttached(): boolean
    detach(): void
  }
  on(event: BrowserGuestEvent, listener: (...args: unknown[]) => void): void
  off(event: BrowserGuestEvent, listener: (...args: unknown[]) => void): void
}

export function lookupElectronGuest(id: number): BrowserGuestContents | undefined {
  const guest = webContents.fromId(id)
  if (!guest) return undefined
  return wrapElectronGuest(guest)
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
    reload: () => guest.reload(),
    stop: () => guest.stop(),
    setWindowOpenHandler: (handler) => {
      guest.setWindowOpenHandler((details) => handler({ url: details.url }))
    },
    debugger: {
      isAttached: () => {
        try {
          return guest.debugger.isAttached()
        } catch {
          return false
        }
      },
      detach: () => {
        guest.debugger.detach()
      }
    },
    on: (event, listener) => {
      guest.on(event as Parameters<WebContents['on']>[0], listener as never)
    },
    off: (event, listener) => {
      guest.off(event as Parameters<WebContents['off']>[0], listener as never)
    }
  }
}
