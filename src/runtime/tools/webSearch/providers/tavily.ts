/**
 * Tavily 搜索 API 适配器
 * 文档：https://docs.tavily.com
 */
import type {
  SearchProvider,
  SearchQueryParams,
  SearchResponse
} from '../types'
import { providerError } from './base'

/** Tavily API 端点 */
const TAVILY_API_URL = 'https://api.tavily.com/search'

/** Tavily API 响应结构（官方文档定义） */
interface TavilyResponse {
  query: string
  answer?: string
  results: Array<{
    title: string
    url: string
    content: string
    published_date?: string
  }>
}

/** Tavily 适配器 */
export const tavilyProvider: SearchProvider = {
  name: 'tavily',

  /** 检查 TAVILY_API_KEY 环境变量是否存在 */
  isAvailable(): boolean {
    return Boolean(process.env.TAVILY_API_KEY)
  },

  async search(params: SearchQueryParams, signal: AbortSignal): Promise<SearchResponse> {
    const apiKey = process.env.TAVILY_API_KEY
    if (!apiKey) {
      throw providerError('tavily', 'TAVILY_API_KEY is not configured')
    }

    const body: Record<string, unknown> = {
      query: params.query,
      max_results: params.maxResults ?? 5,
      search_depth: 'advanced',
      include_answer: true,
      include_raw_content: false
    }

    // recency 映射到 Tavily 的 time_range（全称 day/week/month/year）
    if (params.recency) {
      const recencyMap: Record<string, string> = {
        day: 'day',
        week: 'week',
        month: 'month',
        year: 'year'
      }
      body.time_range = recencyMap[params.recency]
    }

    const response = await fetch(TAVILY_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(body),
      signal
    })

    if (!response.ok) {
      throw providerError(
        'tavily',
        `HTTP ${response.status}: ${response.statusText}`,
        response.status
      )
    }

    let data: TavilyResponse
    try {
      data = (await response.json()) as TavilyResponse
    } catch {
      throw providerError('tavily', 'Invalid JSON response from Tavily')
    }

    return {
      provider: 'tavily',
      answer: data.answer,
      sources: data.results.map(r => ({
        title: r.title,
        url: r.url,
        snippet: r.content,
        publishedDate: r.published_date
      })),
      requestId: crypto.randomUUID()
    }
  }
}
