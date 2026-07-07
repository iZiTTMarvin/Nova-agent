/**
 * Markdown 链接 scheme 白名单
 *
 * 模型输出可能含 javascript: / file: / data: 等危险 href；
 * 非白名单链接降级为纯文本，避免在 Electron 内触发导航或脚本执行。
 */
const BLOCKED_SCHEME_PREFIXES = ['javascript:', 'file:', 'data:', 'vbscript:']

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])

/** 判断 href 是否允许渲染为可点击 <a> */
export function isSafeMarkdownHref(href: string | undefined): boolean {
  if (!href || !href.trim()) return false

  const trimmed = href.trim()
  const lower = trimmed.toLowerCase()
  for (const blocked of BLOCKED_SCHEME_PREFIXES) {
    if (lower.startsWith(blocked)) return false
  }

  try {
    const parsed = trimmed.includes('://')
      ? new URL(trimmed)
      : new URL(trimmed, 'https://example.invalid/')
    return ALLOWED_PROTOCOLS.has(parsed.protocol)
  } catch {
    return false
  }
}
