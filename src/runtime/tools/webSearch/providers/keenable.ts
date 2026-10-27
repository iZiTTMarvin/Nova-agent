import type { SearchProvider, SearchSource } from '../types'
import { withScraperResponse, readScraperText } from '../scraper/http'
import { providerError } from './base'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseSource(value: unknown): SearchSource | undefined {
  if (!isRecord(value) || typeof value.url !== 'string') return undefined
  let url: URL
  try { url = new URL(value.url) } catch { return undefined }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return undefined
  const title = typeof value.title === 'string' && value.title.trim() ? value.title.trim() : url.hostname
  const snippet = typeof value.snippet === 'string' ? value.snippet : typeof value.description === 'string' ? value.description : ''
  return { title, url: url.toString(), ...(snippet ? { snippet: snippet.replace(/\s+/g, ' ').slice(0, 1_000) } : {}) }
}

// 仅使用上游公开的匿名端点；不读取 API Key，也不会创建账号或购买额度。
export const keenableProvider: SearchProvider = {
  name: 'keenable',
  isAvailable: () => true,
  async search(params, signal) {
    const days = params.recency ? { day: 1, week: 7, month: 30, year: 365 }[params.recency] : undefined
    try {
      return await withScraperResponse('https://api.keenable.ai/v1/search/public', {
        method: 'POST', signal, timeoutMs: 8_000,
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Keenable-Title': 'nova-agent' },
        body: JSON.stringify({
          query: params.query, max_results: Math.min(params.maxResults ?? 5, 20), snippet_max_length: 1_000,
          ...(days ? { published_after: new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10) } : {})
        })
      }, async response => {
        if (!response.ok) throw Object.assign(new Error(`搜索服务 HTTP ${response.status}`), { statusCode: response.status })
        const data: unknown = JSON.parse(await readScraperText(response, 512 * 1024))
        if (!isRecord(data) || !Array.isArray(data.results)) throw new Error('搜索响应缺少结果列表')
        const seen = new Set<string>()
        const sources = data.results.flatMap(value => parseSource(value) ?? []).filter(item => {
          if (seen.has(item.url)) return false
          seen.add(item.url)
          return true
        }).slice(0, params.maxResults ?? 5)
        if (!sources.length) throw new Error('搜索未返回可用来源')
        return { provider: 'keenable' as const, sources, requestId: crypto.randomUUID() }
      })
    } catch (error) {
      throw providerError('keenable', error instanceof Error ? error.message : String(error),
        isRecord(error) && typeof error.statusCode === 'number' ? error.statusCode : undefined)
    }
  }
}
