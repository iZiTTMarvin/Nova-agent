/**
 * 宿主窗口的 webview 硬化与弹窗路由。
 * 远程 guest 不得携带 Nova preload，也不得自行关掉沙箱。
 */
import { parseBrowserHttpUrl } from '../../shared/browser'
import { BROWSER_MAX_LIVE_PAGES } from '../../shared/browser/types'

export interface WebviewAttachPreferences {
  sandbox?: boolean
  contextIsolation?: boolean
  nodeIntegration?: boolean
  nodeIntegrationInSubFrames?: boolean
  nodeIntegrationInWorker?: boolean
  webSecurity?: boolean
  allowRunningInsecureContent?: boolean
  webviewTag?: boolean
  preload?: string
}

export interface WebviewAttachParams {
  src?: string
  preload?: string
  nodeintegration?: string
  disablewebsecurity?: string
  allowpopups?: string
}

export interface GuestPopupDecision {
  readonly action: 'deny'
  readonly openInternal?: string
  readonly openExternal?: string
}

export function isAllowedGuestSrc(url: string | undefined): boolean {
  if (url === undefined || url.length === 0) return false
  return parseBrowserHttpUrl(url) !== null
}

export function hardenWebviewAttachment(
  event: { preventDefault(): void },
  webPreferences: WebviewAttachPreferences,
  params: WebviewAttachParams
): 'allowed' | 'blocked' {
  webPreferences.sandbox = true
  webPreferences.contextIsolation = true
  webPreferences.nodeIntegration = false
  webPreferences.nodeIntegrationInSubFrames = false
  webPreferences.nodeIntegrationInWorker = false
  webPreferences.webSecurity = true
  webPreferences.allowRunningInsecureContent = false
  webPreferences.webviewTag = false
  delete webPreferences.preload
  delete params.preload
  delete params.nodeintegration
  delete params.disablewebsecurity
  params.allowpopups = 'true'

  if (!isAllowedGuestSrc(params.src)) {
    event.preventDefault()
    return 'blocked'
  }
  return 'allowed'
}

export function routeGuestPopup(
  url: string,
  livePageCount: number
): GuestPopupDecision {
  const allowed = parseBrowserHttpUrl(url)
  if (allowed === null) {
    return { action: 'deny' }
  }
  if (livePageCount < BROWSER_MAX_LIVE_PAGES) {
    return { action: 'deny', openInternal: allowed }
  }
  return { action: 'deny', openExternal: allowed }
}
