/**
 * Bing HTML 爬虫 Provider
 * 零配置可用，不依赖 API Key
 */
import type { SearchProvider, SearchQueryParams, SearchResponse } from '../types'
import { providerError } from './base'
import { scraperFetch } from '../scraper/http'
import { parseBingHtml } from '../scraper/bingParser'

/** Bing 搜索页基础 URL */
const BING_SEARCH_URL = 'https://www.bing.com/search'

export const bingProvider: SearchProvider = {
  name: 'bing',

  /** 爬虫 provider 始终可用 */
  isAvailable(): boolean {
    return true
  },

  async search(params: SearchQueryParams, signal: AbortSignal): Promise<SearchResponse> {
    const maxResults = Math.min(params.maxResults ?? 5, 20)
    const query = encodeURIComponent(params.query)
    const url = `${BING_SEARCH_URL}?q=${query}&count=${maxResults}&setmkt=en-US`

    let html: string
    try {
      html = await scraperFetch(url, { signal })
    } catch (err) {
      throw providerError(
        'bing',
        err instanceof Error ? err.message : String(err)
      )
    }

    const sources = parseBingHtml(html, maxResults)
    if (sources.length === 0) {
      throw providerError('bing', '未能从 Bing 页面解析出搜索结果（可能遭遇反爬或页面结构变更）')
    }

    return {
      provider: 'bing',
      sources,
      requestId: crypto.randomUUID()
    }
  }
}
