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

/**
 * 域名解析结果注入点：数组=解析到的全部地址，null=解析失败或超时，
 * undefined=没有该主机的解析信息（按主机名字面分类）。
 * shared 只消费结果，不自己发起解析。
 */
export type PreviewHostResolver = (hostname: string) => readonly string[] | null | undefined

export interface CanonicalPreviewTarget {
  readonly protocol: 'http:' | 'https:' | 'ws:' | 'wss:'
  readonly hostname: string
  readonly port: string
  readonly origin: string
  readonly addressClass: PreviewAddressClass
}

export type PreviewHostResolution = 'literal' | 'resolved' | 'unresolved' | 'not-tried'

export interface PreviewTargetEvaluation {
  readonly canonical: CanonicalPreviewTarget
  /** literal=字面即可分类；resolved=已按解析地址聚合；unresolved=解析失败；not-tried=域名但无解析信息 */
  readonly resolution: PreviewHostResolution
}

export function normalizePreviewHostname(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.+$/, '')
}

export function classifyPreviewHostname(hostname: string): PreviewAddressClass {
  const bare = normalizePreviewHostname(hostname)
  if (METADATA_HOSTS.has(bare)) return 'metadata'
  if (bare === 'localhost') return 'loopback'
  if (!isIpLiteral(bare)) return 'public'
  const ipClass = classifyIp(bare)
  if (ipClass === 'cloud-metadata') return 'metadata'
  if (ipClass === 'loopback') return 'loopback'
  if (ipClass === 'private') return 'private'
  return 'public'
}

/** 域名（非 IP 字面量、非 localhost、非元数据主机）的类别要靠解析地址决定。 */
export function previewHostnameNeedsResolution(hostname: string): boolean {
  const bare = normalizePreviewHostname(hostname)
  if (METADATA_HOSTS.has(bare)) return false
  if (bare === 'localhost') return false
  return !isIpLiteral(bare)
}

/** 任一地址受限即按受限处理；元数据最严，其次 loopback，再次 private，与顺序无关。 */
export function resolvePreviewAddressClass(addresses: readonly string[]): PreviewAddressClass {
  let sawLoopback = false
  let sawPrivate = false
  for (const address of addresses) {
    const ipClass = classifyIp(address)
    if (ipClass === 'cloud-metadata') return 'metadata'
    if (ipClass === 'loopback') sawLoopback = true
    else if (ipClass === 'private') sawPrivate = true
  }
  if (sawLoopback) return 'loopback'
  if (sawPrivate) return 'private'
  return 'public'
}

export function evaluatePreviewTarget(
  url: string,
  resolveHost?: PreviewHostResolver
): PreviewTargetEvaluation | null {
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
  const literalClass = classifyPreviewHostname(hostname)
  const needsResolution = previewHostnameNeedsResolution(hostname)
  if (!needsResolution || !resolveHost) {
    return {
      canonical: buildCanonical(parsed, protocol, hostname, literalClass),
      resolution: needsResolution ? 'not-tried' : 'literal'
    }
  }
  const resolved = resolveHost(normalizePreviewHostname(hostname))
  if (resolved === undefined) {
    return {
      canonical: buildCanonical(parsed, protocol, hostname, literalClass),
      resolution: 'not-tried'
    }
  }
  if (resolved === null || resolved.length === 0) {
    // 解析失败与零地址同样拒绝，与打开确认的语义一致
    return { canonical: buildCanonical(parsed, protocol, hostname, literalClass), resolution: 'unresolved' }
  }
  return {
    canonical: buildCanonical(parsed, protocol, hostname, resolvePreviewAddressClass(resolved)),
    resolution: 'resolved'
  }
}

export function canonicalizePreviewTarget(url: string): CanonicalPreviewTarget | null {
  return evaluatePreviewTarget(url)?.canonical ?? null
}

function buildCanonical(
  parsed: URL,
  protocol: CanonicalPreviewTarget['protocol'],
  hostname: string,
  addressClass: PreviewAddressClass
): CanonicalPreviewTarget {
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
  /** 域名解析结果；解析失败的目标或发起方直接拒绝。 */
  readonly resolveHost?: PreviewHostResolver
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
  const targetEval = evaluatePreviewTarget(target, input.resolveHost)
  if (!targetEval || targetEval.resolution === 'unresolved') return 'deny'
  const canonical = targetEval.canonical
  if (canonical.addressClass === 'metadata') return 'deny'
  if (canonical.addressClass === 'public') return 'allow'
  if (input.resourceType === 'mainFrame') {
    if (canonical.protocol !== 'http:' && canonical.protocol !== 'https:') return 'deny'
    return input.grantedOrigins.some((origin) => origin === canonical.origin) ? 'allow' : 'deny'
  }
  const initiatorEval = evaluatePreviewTarget(input.initiatorOrigin ?? '', input.resolveHost)
  if (!initiatorEval || initiatorEval.resolution === 'unresolved') return 'deny'
  const initiator = initiatorEval.canonical
  if (!input.grantedOrigins.some((origin) => origin === initiator.origin)) return 'deny'
  if (initiator.addressClass !== 'loopback' && initiator.addressClass !== 'private') return 'deny'
  if (initiator.hostname !== canonical.hostname || initiator.port !== canonical.port) return 'deny'
  if (!protocolCompatible(initiator.protocol, canonical.protocol)) return 'deny'
  return 'allow'
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
