/**
 * web_fetch 的 URL 安全闸门：scheme 白名单 + 网段三级判定 + 域名 DNS 兜底。
 *
 * 与权限层的分工：initial 模式（工具入口）对私网 IP 字面量放行——那里有
 * 权限层升格 ask 把关（effectResolver）；per-hop 模式（重定向每一跳）对
 * 私网一律 fail-close——权限层只审过初始 URL，重定向进内网就是绕过路径。
 * 域名解析到私网/云元数据在两种模式下都拒绝。
 */
import { lookup } from 'dns/promises'
import { classifyIp } from '../../../shared/permissions/ipClassify'

export type UrlGateMode = 'initial' | 'per-hop'

export type UrlGateDenyReason =
  | 'invalid-url'
  | 'scheme'
  | 'cloud-metadata'
  | 'private-dns'
  | 'private-redirect'

export type UrlGateVerdict =
  | { ok: true; normalizedUrl: string }
  | { ok: false; reason: UrlGateDenyReason; detail: string }

const ALLOWED_SCHEMES: ReadonlySet<string> = new Set(['http:', 'https:'])

/** 同步校验：URL 合法性 + scheme 白名单 + IP 字面量网段（不走 DNS） */
export function checkUrlSync(url: string, mode: UrlGateMode = 'initial'): UrlGateVerdict {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { ok: false, reason: 'invalid-url', detail: '不是合法的 URL' }
  }
  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    return { ok: false, reason: 'scheme', detail: `仅支持 http/https，收到 ${parsed.protocol}` }
  }
  // 云元数据必须无条件拒绝：字面量与解析后都拦
  const host = parsed.hostname.replace(/^\[|\]$/g, '')
  if (classifyIp(host) === 'cloud-metadata') {
    return { ok: false, reason: 'cloud-metadata', detail: '云元数据地址禁止访问' }
  }
  if (mode === 'per-hop' && classifyIp(host) === 'private') {
    return {
      ok: false,
      reason: 'private-redirect',
      detail: '重定向进入内网地址，已中止抓取（防绕过：公网页面 302 到内网是已知攻击路径）'
    }
  }
  return { ok: true, normalizedUrl: parsed.toString() }
}

/**
 * 完整校验（含 DNS）：域名解析出的每个地址都过网段判定。
 * 解析到私网 → 拒绝（fail-close，文案说明放行方式）；云元数据 → 拒绝。
 * loopback 放行：桌面开发工具读 localhost 是日常主场景。
 */
export async function checkUrl(url: string, mode: UrlGateMode = 'initial'): Promise<UrlGateVerdict> {
  const sync = checkUrlSync(url, mode)
  if (!sync.ok) return sync

  const host = new URL(sync.normalizedUrl).hostname.replace(/^\[|\]$/g, '')
  // IP 字面量：initial 模式私网交权限层 ask；per-hop 已在上面拦截
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')) return sync

  let addresses: { address: string }[]
  try {
    addresses = await lookup(host, { all: true })
  } catch {
    return { ok: false, reason: 'invalid-url', detail: `域名解析失败：${host}` }
  }
  for (const { address } of addresses) {
    const ipClass = classifyIp(address)
    if (ipClass === 'cloud-metadata') {
      return { ok: false, reason: 'cloud-metadata', detail: '域名解析到云元数据地址，禁止访问' }
    }
    if (ipClass === 'private') {
      return {
        ok: false,
        reason: 'private-dns',
        detail: `域名 ${host} 解析到内网地址 ${address}，已阻止。确需访问请改用 IP 地址（会请求你的确认）`
      }
    }
  }
  return sync
}
