/**
 * Bing 搜索页 HTML 解析器
 * 目标结构：<li class="b_algo"> 内的 h2/a 标题链接 + p.b_lineclamp 摘要
 */
import type { SearchSource } from '../types'
import { stripHtml } from './htmlUtils'

/**
 * 解码 Bing 重定向 URL（bing.com/ck/a?...&u=a1<base64url>）
 * u 参数常以 a1 前缀 + base64url 编码的真实 URL
 */
export function decodeBingRedirectUrl(href: string): string {
  // HTML 属性中 & 常被编码为 &amp;
  const normalized = href.replace(/&amp;/g, '&')

  if (!normalized.includes('bing.com/ck/a')) {
    return normalized
  }

  try {
    const absolute = normalized.startsWith('http') ? normalized : `https://www.bing.com${normalized}`
    const parsed = new URL(absolute)
    const encoded = parsed.searchParams.get('u')
    if (!encoded) return normalized

    // 去掉 a1 前缀后做 base64url 解码
    const payload = encoded.startsWith('a1') ? encoded.slice(2) : encoded
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/')
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
    const decoded = Buffer.from(padded, 'base64').toString('utf-8')
    if (decoded.startsWith('http')) {
      return decoded
    }
  } catch {
    // 解码失败则返回原始 href
  }

  return normalized
}

/**
 * 从 Bing 搜索页 HTML 提取搜索结果列表
 */
export function parseBingHtml(html: string, maxResults: number): SearchSource[] {
  const sources: SearchSource[] = []
  const blockRegex = /<li[^>]*class="[^"]*b_algo[^"]*"[^>]*>([\s\S]*?)<\/li>/gi
  let blockMatch: RegExpExecArray | null

  while ((blockMatch = blockRegex.exec(html)) !== null && sources.length < maxResults) {
    const block = blockMatch[1]

    // 标题与链接：h2 > a
    const linkMatch =
      /<h2[^>]*>\s*<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>\s*<\/h2>/i.exec(block) ??
      /<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i.exec(block)

    if (!linkMatch) continue

    const rawUrl = decodeBingRedirectUrl(linkMatch[1].trim())
    const title = stripHtml(linkMatch[2])
    if (!title || !rawUrl) continue

    // 摘要：优先 p.b_lineclamp，其次任意 p 标签
    const snippetMatch =
      /<p[^>]*class="[^"]*b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(block) ??
      /<p[^>]*>([\s\S]*?)<\/p>/i.exec(block)
    const snippet = snippetMatch ? stripHtml(snippetMatch[1]) : undefined

    sources.push({
      title,
      url: rawUrl,
      snippet: snippet || undefined
    })
  }

  return sources
}
