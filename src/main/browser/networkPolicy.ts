/**
 * 每个浏览器 partition 只有一份请求与权限策略。
 * 后一次安装不得再注册监听，避免盖掉当前 Owner。
 */
import {
  decideBrowserNetworkRequest,
  type BrowserNetworkRequest
} from '../../shared/browser/previewOrigin'

export interface PartitionRequestDetails {
  readonly url: string
  readonly resourceType: string
  readonly initiatorOrigin?: string
  readonly webContentsId?: number
}

export interface PartitionPolicySink {
  grantsFor(webContentsId: number | undefined): readonly string[]
  onPermissionDenied(input: {
    readonly webContentsId: number | undefined
    readonly permission: string
    readonly requestingUrl: string
  }): void
  onDownloadDenied(input: {
    readonly webContentsId: number | undefined
    readonly filename: string
    readonly url: string
  }): void
}

export interface PartitionPolicySession {
  webRequest: {
    onBeforeRequest(
      filter: { urls: string[] },
      listener: (
        details: PartitionRequestDetails,
        callback: (response: { cancel: boolean }) => void
      ) => void
    ): void
  }
  setPermissionRequestHandler(handler: (
    webContents: { id: number } | null,
    permission: string,
    callback: (granted: boolean) => void,
    details: { requestingUrl?: string }
  ) => void): void
  setPermissionCheckHandler(handler: (
    webContents: { id: number } | null,
    permission: string,
    requestingOrigin: string
  ) => boolean): void
  on(
    event: 'will-download',
    listener: (
      event: { preventDefault(): void },
      item: { getFilename(): string; getURL(): string; cancel(): void },
      webContents: { id: number } | null
    ) => void
  ): void
}

const RESOURCE_TYPES = new Set<BrowserNetworkRequest['resourceType']>([
  'mainFrame',
  'subFrame',
  'stylesheet',
  'script',
  'image',
  'font',
  'object',
  'xhr',
  'ping',
  'cspReport',
  'media',
  'webSocket',
  'other'
])

const installed = new Set<string>()

export function resetBrowserPartitionPolicyForTests(): void {
  installed.clear()
}

export function decidePartitionRequest(
  details: PartitionRequestDetails,
  grantedOrigins: readonly string[]
): 'allow' | 'deny' {
  return decideBrowserNetworkRequest({
    targetUrl: details.url,
    initiatorOrigin: details.initiatorOrigin ?? null,
    resourceType: resourceTypeOf(details.resourceType),
    grantedOrigins
  })
}

export function guestPermissionMessage(permission: string, requestingUrl: string): string {
  if (permission === 'media' || permission === 'display-capture') {
    return `已拒绝摄像头、麦克风或屏幕捕获。来源 ${requestingUrl}`
  }
  if (permission === 'notifications') {
    return `已拒绝通知。来源 ${requestingUrl}`
  }
  if (permission === 'fileSystem') {
    return `已拒绝访问本机文件。来源 ${requestingUrl}`
  }
  return `已拒绝页面权限 ${permission}。来源 ${requestingUrl}`
}

export function guestDownloadMessage(filename: string, url: string): string {
  const name = filename.trim().length > 0 ? filename : '未命名文件'
  return `已拒绝下载 ${name}。来源 ${url}`
}

export function installBrowserPartitionPolicy(
  partition: string,
  ses: PartitionPolicySession,
  sink: PartitionPolicySink
): void {
  if (installed.has(partition)) return
  installed.add(partition)
  ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    const decision = decidePartitionRequest(details, sink.grantsFor(details.webContentsId))
    callback({ cancel: decision === 'deny' })
  })
  ses.setPermissionCheckHandler(() => false)
  ses.setPermissionRequestHandler((webContents, permission, callback, details) => {
    callback(false)
    const requestingUrl = details.requestingUrl ?? ''
    sink.onPermissionDenied({
      webContentsId: webContents?.id,
      permission,
      requestingUrl
    })
  })
  ses.on('will-download', (event, item, webContents) => {
    event.preventDefault()
    const url = item.getURL()
    const filename = item.getFilename()
    item.cancel()
    sink.onDownloadDenied({
      webContentsId: webContents?.id,
      filename,
      url
    })
  })
}

function resourceTypeOf(value: string): BrowserNetworkRequest['resourceType'] {
  if (RESOURCE_TYPES.has(value as BrowserNetworkRequest['resourceType'])) {
    return value as BrowserNetworkRequest['resourceType']
  }
  return 'other'
}
