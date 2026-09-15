/**
 * IP 网段分类：web_fetch 安全闸门与权限升格共用的判定原语。
 *
 * 三级语义（nova 方案）：loopback 放行（开发场景本体）、私网段升格确认、
 * 云元数据无条件禁止。只认 IP 字面量；域名解析后的判定由调用方在 fetch 前做。
 */

export type IpClass = 'loopback' | 'cloud-metadata' | 'private' | 'public'

function ipv4ToInt(ip: string): number {
  const parts = ip.split('.')
  return ((Number(parts[0]) << 24) | (Number(parts[1]) << 16) | (Number(parts[2]) << 8) | Number(parts[3])) >>> 0
}

function inCidr4(ip: number, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0
  return (ip & mask) === (ipv4ToInt(base) & mask)
}

/** 云元数据端点：桌面机没有，但拦截成本为零且语义清晰 */
const CLOUD_METADATA_IPS: ReadonlySet<string> = new Set([
  '169.254.169.254', // AWS/GCP/Azure/阿里云 IMDS
  '169.254.170.2', // AWS ECS 容器凭据
  '100.100.100.200', // 阿里云 IMDS
  'fd00:ec2::254' // AWS IMDS IPv6
])

export function classifyIp(ip: string): IpClass {
  if (CLOUD_METADATA_IPS.has(ip)) return 'cloud-metadata'
  // IPv4-mapped IPv6 按内嵌 IPv4 递归分类，否则映射地址能穿透私网判定
  // （Node fetch 会经映射地址连到 IPv4 目标）。两种形态都要认：
  // 十进制 ::ffff:10.0.0.1 与 URL 规范化后的十六进制 ::ffff:a00:1
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip)
  if (mapped) return classifyIp(mapped[1]!)
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(ip)
  if (mappedHex) {
    const hi = parseInt(mappedHex[1]!, 16)
    const lo = parseInt(mappedHex[2]!, 16)
    const v4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`
    return classifyIp(v4)
  }
  if (ip === '::1' || ip === 'localhost' || ip === '::' || ip === '0.0.0.0') return 'loopback'
  if (/^127\./.test(ip)) return 'loopback'
  if (net_isV4(ip)) {
    const v4 = ipv4ToInt(ip)
    if (inCidr4(v4, '10.0.0.0', 8)) return 'private'
    if (inCidr4(v4, '172.16.0.0', 12)) return 'private'
    if (inCidr4(v4, '192.168.0.0', 16)) return 'private'
    if (inCidr4(v4, '169.254.0.0', 16)) return 'private'
    if (inCidr4(v4, '100.64.0.0', 10)) return 'private' // CGNAT
    return 'public'
  }
  // IPv6 私有段：ULA fc00::/7 与链路本地 fe80::/10
  const lower = ip.toLowerCase()
  if (lower.startsWith('fc') || lower.startsWith('fd')) return 'private'
  if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return 'private'
  return 'public'
}

function net_isV4(ip: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(ip)
}
