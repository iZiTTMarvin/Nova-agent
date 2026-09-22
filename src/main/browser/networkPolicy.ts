/**
 * 每个浏览器 partition 只有一份请求与权限策略。
 * 后一次安装不得再注册监听，避免盖掉当前 Owner。
 * 域名请求先经有期限的地址解析，再按受限地址规则决策。
 */
import { lookup } from 'node:dns/promises'
import {
  canonicalizePreviewTarget,
  decideBrowserNetworkRequest,
  normalizePreviewHostname,
  previewHostnameNeedsResolution,
  type BrowserNetworkRequest,
  type PreviewHostResolver
} from '../../shared/browser'
import type { PreviewHostLookup } from './previewGrants'

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

/** 域名解析结果的缓存期限、单次解析等待上限与缓存条目上限。 */
export const PARTITION_HOST_TTL_MS = 60_000
export const PARTITION_HOST_TIMEOUT_MS = 3_000
export const PARTITION_HOST_CACHE_LIMIT = 256

export function resetBrowserPartitionPolicyForTests(): void {
  installed.clear()
}

/**
 * 有期限的域名地址解析：成功结果缓存一个 TTL 后失效，失败不缓存（网络恢复即可重试）；
 * 缓存有容量上限，写入时先清过期再淘汰最旧。不做后台刷新。
 * DNS 检查与实际连接之间仍存在重绑定窗口，这里不做系统级网络隔离。
 */
export function createPartitionHostResolver(options: {
  readonly ttlMs?: number
  readonly timeoutMs?: number
  readonly cacheLimit?: number
  readonly now?: () => number
  readonly lookupHost?: (hostname: string) => Promise<readonly string[] | null>
} = {}): PreviewHostLookup {
  const ttlMs = options.ttlMs ?? PARTITION_HOST_TTL_MS
  const timeoutMs = options.timeoutMs ?? PARTITION_HOST_TIMEOUT_MS
  const cacheLimit = options.cacheLimit ?? PARTITION_HOST_CACHE_LIMIT
  const now = options.now ?? Date.now
  const cache = new Map<string, { at: number; addresses: readonly string[] }>()
  const inflight = new Map<string, Promise<readonly string[] | null>>()
  const lookupHost = options.lookupHost ?? defaultLookupHost(timeoutMs)

  function defaultLookupHost(timeout: number): (hostname: string) => Promise<readonly string[] | null> {
    return async (hostname) => {
      const timer = new Promise<null>((resolve) => {
        setTimeout(() => resolve(null), timeout).unref?.()
      })
      const lookedUp = lookup(hostname, { all: true }).then(
        (entries) => (entries.length > 0 ? entries.map((entry) => entry.address) : null),
        () => null
      )
      return Promise.race([lookedUp, timer])
    }
  }

  function remember(key: string, addresses: readonly string[]): void {
    if (cache.size >= cacheLimit) {
      for (const [entry, cached] of cache) {
        if (cache.size < cacheLimit) break
        if (now() - cached.at > ttlMs || entry === cache.keys().next().value) cache.delete(entry)
      }
    }
    cache.set(key, { at: now(), addresses })
  }

  return (hostname) => {
    const key = normalizePreviewHostname(hostname)
    const cached = cache.get(key)
    if (cached && now() - cached.at <= ttlMs) return Promise.resolve(cached.addresses)
    const pending = inflight.get(key)
    if (pending) return pending
    const started = lookupHost(key).then(
      (addresses) => {
        if (addresses !== null) remember(key, addresses)
        return addresses
      },
      () => {
        // 注入的解析实现拒绝时按失败处理，且不能滞留在途表
        return null
      }
    )
    inflight.set(key, started.finally(() => {
      inflight.delete(key)
    }))
    return started
  }
}

export function decidePartitionRequest(
  details: PartitionRequestDetails,
  grantedOrigins: readonly string[],
  resolveHost?: PreviewHostResolver
): 'allow' | 'deny' {
  return decideBrowserNetworkRequest({
    targetUrl: details.url,
    initiatorOrigin: details.initiatorOrigin ?? null,
    resourceType: resourceTypeOf(details.resourceType),
    grantedOrigins,
    ...(resolveHost ? { resolveHost } : {})
  })
}

/** 参与决策的域名才解析：目标始终要查；发起方只在授权命中后才影响分类。 */
function hostsToResolve(
  details: PartitionRequestDetails,
  grantedOrigins: readonly string[]
): readonly string[] {
  const hosts = new Set<string>()
  const addTarget = (url: string | undefined): void => {
    if (!url) return
    const canonical = canonicalizePreviewTarget(url)
    if (canonical && previewHostnameNeedsResolution(canonical.hostname)) {
      hosts.add(normalizePreviewHostname(canonical.hostname))
    }
  }
  addTarget(details.url)
  if (resourceTypeOf(details.resourceType) !== 'mainFrame') {
    const initiator = details.initiatorOrigin ? canonicalizePreviewTarget(details.initiatorOrigin) : null
    if (initiator && grantedOrigins.includes(initiator.origin)) {
      addTarget(details.initiatorOrigin)
    }
  }
  return [...hosts]
}

async function resolveAndDecide(
  details: PartitionRequestDetails,
  sink: PartitionPolicySink,
  resolveHost: PreviewHostLookup,
  callback: (response: { cancel: boolean }) => void
): Promise<void> {
  let settled = false
  const finish = (cancel: boolean): void => {
    if (settled) return
    settled = true
    callback({ cancel })
  }
  try {
    const hosts = hostsToResolve(details, sink.grantsFor(details.webContentsId))
    if (hosts.length === 0) {
      finish(decidePartitionRequest(details, sink.grantsFor(details.webContentsId)) === 'deny')
      return
    }
    const table = new Map<string, readonly string[] | null>()
    await Promise.all(
      hosts.map(async (host) => {
        table.set(host, await resolveHost(host))
      })
    )
    // 解析等待期间授权可能变化，决策前复核
    const grants = sink.grantsFor(details.webContentsId)
    const lookupHost: PreviewHostResolver = (host) =>
      table.has(host) ? table.get(host) : undefined
    const decision = decidePartitionRequest(details, grants, lookupHost)
    finish(decision === 'deny')
  } catch {
    finish(true)
  }
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
  sink: PartitionPolicySink,
  options: { readonly resolveHost?: PreviewHostLookup } = {}
): void {
  if (installed.has(partition)) return
  installed.add(partition)
  const resolveHost = options.resolveHost
  ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    if (!resolveHost) {
      const decision = decidePartitionRequest(details, sink.grantsFor(details.webContentsId))
      callback({ cancel: decision === 'deny' })
      return
    }
    void resolveAndDecide(details, sink, resolveHost, callback)
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
