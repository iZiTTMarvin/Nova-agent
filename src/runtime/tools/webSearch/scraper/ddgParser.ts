/**
 * DuckDuckGo HTML 搜索页解析器
 * 目标结构：a.result__a 标题链接 + .result__snippet 摘要
 */
import type { SearchSource } from '../types'
import { stripHtml } from './htmlUtils'

/**
 * 从 DDG 跳转链接解出真实 URL（uddg= 查询参数）
 */
export function decodeDdgRedirectUrl(href: string): string {
  try {
    const absolute = href.startsWith('http')
      ? href
      : href.startsWith('//')
        ? `https:${href}`
        : `https://duckduckgo.com${href.startsWith('/') ? href : `/${href}`}`

    const parsed = new URL(absolute)
    const uddg = parsed.searchParams.get('uddg')
    if (uddg) {
      return decodeURIComponent(uddg)
    }
    return absolute
  } catch {
    return href
  }
}

/**
 * 从 DuckDuckGo HTML 搜索页提取搜索结果列表
 */
export function parseDdgHtml(html: string, maxResults: number): SearchSource[] {
  const sources: SearchSource[] = []

  // 按 result 区块切分，跳过广告（检查 opening tag 是否含 result--ad）
  const resultBlockRegex =
    /<div([^>]*class="[^"]*result[^"]*results_links[^"]*"[^>]*)>([\s\S]*?)<\/div>\s*(?=<div[^>]*class="[^"]*result|$)/gi
  let blockMatch: RegExpExecArray | null

  const blocks: Array<{ openTag: string; content: string }> = []
  while ((blockMatch = resultBlockRegex.exec(html)) !== null) {
    blocks.push({ openTag: blockMatch[1], content: blockMatch[2] })
  }

  // 若区块正则未命中，退化为全局扫描 result__a
  const iterable = blocks.length > 0 ? blocks : [{ openTag: '', content: html }]

  for (const { openTag, content: block } of iterable) {
    if (sources.length >= maxResults) break

    // 跳过广告结果
    if (/result--ad/i.test(openTag)) continue

    const linkMatch = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i.exec(
      block
    )
    if (!linkMatch) continue

    const rawUrl = decodeDdgRedirectUrl(linkMatch[1].trim())
    const title = stripHtml(linkMatch[2])
    if (!title || !rawUrl.startsWith('http')) continue

    // 摘要：a.result__snippet 或任意带 result__snippet class 的元素
    const snippetMatch =
      /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(block) ??
      /<(?:a|div|span)[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|span)>/i.exec(
        block
      )
    const snippet = snippetMatch ? stripHtml(snippetMatch[1]) : undefined

    sources.push({
      title,
      url: rawUrl,
      snippet: snippet || undefined
    })
  }

  return sources
}
