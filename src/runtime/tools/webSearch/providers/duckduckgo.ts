/**
 * DuckDuckGo HTML 爬虫 Provider
 * 零配置可用；网络/HTTP 失败后进入 10 分钟进程内冷却
 */
import type { SearchProvider, SearchQueryParams, SearchResponse } from '../types'
import { providerError } from './base'
import { parseDdgHtml } from '../scraper/ddgParser'

/** DDG HTML 搜索端点 */
const DDG_SEARCH_URL = 'https://html.duckduckgo.com/html/'

/** 失败后冷却时长（10 分钟） */
const DDG_COOLDOWN_MS = 10 * 60 * 1000

/** 模块级冷却截止时间戳（0 表示未冷却） */
let ddgUnavailableUntil = 0

/** 标记 DDG 进入冷却期（供测试重置） */
export function markDdgUnavailable(): void {
  ddgUnavailableUntil = Date.now() + DDG_COOLDOWN_MS
}

/** 重置冷却状态（仅测试使用） */
export function resetDdgCooldown(): void {
  ddgUnavailableUntil = 0
}

/** 查询当前是否处于冷却期 */
export function isDdgInCooldown(): boolean {
  return Date.now() < ddgUnavailableUntil
}

/** 判断是否为请求取消（取消不应触发冷却） */
function isAbortError(err: unknown, signal: AbortSignal): boolean {
  return (
    signal.aborted ||
    (err instanceof Error && err.name === 'AbortError') ||
    (err instanceof DOMException && err.name === 'AbortError')
  )
}

export const duckduckgoProvider: SearchProvider = {
  name: 'duckduckgo',

  /** 冷却期内不可用，否则始终尝试 */
  isAvailable(): boolean {
    return !isDdgInCooldown()
  },

  async search(params: SearchQueryParams, signal: AbortSignal): Promise<SearchResponse> {
    const maxResults = Math.min(params.maxResults ?? 5, 20)
    const body = new URLSearchParams({ q: params.query })

    let html: string
    try {
      const response = await fetch(DDG_SEARCH_URL, {
        method: 'POST',
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Encoding': 'identity'
        },
        body: body.toString(),
        signal
      })

      if (!response.ok) {
        markDdgUnavailable()
        throw providerError(
          'duckduckgo',
          `HTTP ${response.status}: ${response.statusText}`,
          response.status
        )
      }

      html = await response.text()
    } catch (err) {
      // 用户取消不触发冷却
      if (isAbortError(err, signal)) {
        throw providerError('duckduckgo', '请求已取消')
      }
      if (err && typeof err === 'object' && 'provider' in err) {
        markDdgUnavailable()
        throw err
      }
      markDdgUnavailable()
      throw providerError(
        'duckduckgo',
        err instanceof Error ? err.message : String(err)
      )
    }

    const sources = parseDdgHtml(html, maxResults)
    // 零结果视为正常响应：不触发冷却，由工具层 fallback 到下一 provider
    if (sources.length === 0) {
      throw providerError('duckduckgo', '未返回搜索结果')
    }

    return {
      provider: 'duckduckgo',
      sources,
      requestId: crypto.randomUUID()
    }
  }
}
