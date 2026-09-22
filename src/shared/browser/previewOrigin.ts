/**
 * 预览 origin 只认协议、主机和端口。
 * URL 解析会把同一 IPv4 的不同字面量收成一个 origin；
 * localhost、127.0.0.1 与 [::1] 仍是三个 origin，不能互相代替，也不能覆盖其它端口。
 */
import { classifyIp } from '../permissions/ipClassify'

export type PreviewAddressClass = 'public' | 'loopback' | 'private' | 'metadata'

const METADATA_HOSTS = new Set([
  'metadata.google.internal',
  'metadata.google.com'
])

const NETWORK_PROTOCOLS = new Set(['http:', 'https:', 'ws:', 'wss:'])

export interface CanonicalPreviewTarget {
  readonly protocol: 'http:' | 'https:' | 'ws:' | 'wss:'
  readonly hostname: string
  readonly port: string
  readonly origin: string
  readonly addressClass: PreviewAddressClass
}

export function classifyPreviewHostname(hostname: string): PreviewAddressClass {
  const bare = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (METADATA_HOSTS.has(bare)) return 'metadata'
  if (bare === 'localhost') return 'loopback'
  if (!isIpLiteral(bare)) return 'public'
  const ipClass = classifyIp(bare)
  if (ipClass === 'cloud-metadata') return 'metadata'
  if (ipClass === 'loopback') return 'loopback'
  if (ipClass === 'private') return 'private'
  return 'public'
}

export function canonicalizePreviewTarget(url: string): CanonicalPreviewTarget | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (!NETWORK_PROTOCOLS.has(parsed.protocol)) return null
  if (parsed.username !== '' || parsed.password !== '') return null
  const protocol = parsed.protocol as CanonicalPreviewTarget['protocol']
  const hostname = parsed.hostname
  const addressClass = classifyPreviewHostname(hostname)
  return {
    protocol,
    hostname,
    port: effectivePort(protocol, parsed.port),
    origin: parsed.origin,
    addressClass
  }
}

export function previewOriginsMatch(left: string, right: string): boolean {
  const a = canonicalizePreviewTarget(left)
  const b = canonicalizePreviewTarget(right)
  if (!a || !b) return false
  return a.origin === b.origin
}

export interface BrowserNetworkRequest {
  readonly targetUrl: string
  readonly initiatorOrigin: string | null
  readonly resourceType:
    | 'mainFrame'
    | 'subFrame'
    | 'stylesheet'
    | 'script'
    | 'image'
    | 'font'
    | 'object'
    | 'xhr'
    | 'ping'
    | 'cspReport'
    | 'media'
    | 'webSocket'
    | 'other'
  readonly grantedOrigins: readonly string[]
}

/**
 * 受限地址只放行「已确认 origin 自己的页面」访问同一主机和端口（含对应 HMR）。
 * 另一个端口、另一种 loopback 写法，或公网页面，都不能借用这份授权。
 */
export function decideBrowserNetworkRequest(input: BrowserNetworkRequest): 'allow' | 'deny' {
  const target = input.targetUrl.trim()
  if (target.length === 0) return 'deny'
  let protocol: string
  try {
    protocol = new URL(target).protocol
  } catch {
    return 'deny'
  }
  if (protocol === 'data:' || protocol === 'blob:') return 'allow'
  const canonical = canonicalizePreviewTarget(target)
  if (!canonical) return 'deny'
  if (canonical.addressClass === 'metadata') return 'deny'
  if (canonical.addressClass === 'public') return 'allow'
  if (input.resourceType === 'mainFrame') {
    if (canonical.protocol !== 'http:' && canonical.protocol !== 'https:') return 'deny'
    return input.grantedOrigins.some((origin) => origin === canonical.origin) ? 'allow' : 'deny'
  }
  const initiator = initiatorTarget(input.initiatorOrigin)
  if (!initiator) return 'deny'
  if (!input.grantedOrigins.some((origin) => origin === initiator.origin)) return 'deny'
  if (initiator.addressClass !== 'loopback' && initiator.addressClass !== 'private') return 'deny'
  if (initiator.hostname !== canonical.hostname || initiator.port !== canonical.port) return 'deny'
  if (!protocolCompatible(initiator.protocol, canonical.protocol)) return 'deny'
  return 'allow'
}

function initiatorTarget(origin: string | null): CanonicalPreviewTarget | null {
  if (!origin) return null
  return canonicalizePreviewTarget(origin)
}

function protocolCompatible(
  documentProtocol: CanonicalPreviewTarget['protocol'],
  targetProtocol: CanonicalPreviewTarget['protocol']
): boolean {
  if (documentProtocol === 'http:') return targetProtocol === 'http:' || targetProtocol === 'ws:'
  if (documentProtocol === 'https:') return targetProtocol === 'https:' || targetProtocol === 'wss:'
  return false
}

function effectivePort(protocol: string, port: string): string {
  if (port.length > 0) return port
  if (protocol === 'http:' || protocol === 'ws:') return '80'
  if (protocol === 'https:' || protocol === 'wss:') return '443'
  return port
}

function isIpLiteral(host: string): boolean {
  if (host.includes(':')) return true
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host)
}
