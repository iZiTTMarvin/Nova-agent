/**
 * Provider 链管理：按 fallback 顺序返回可用 provider
 * 顺序：bing → duckduckgo → tavily（Tavily 需 API Key）
 */
import type { SearchProvider } from '../types'
import { bingProvider } from './bing'
import { duckduckgoProvider } from './duckduckgo'
import { tavilyProvider } from './tavily'

/** Provider fallback 顺序；第一个最优先，全失败才试下一个 */
export const SEARCH_PROVIDER_ORDER: Array<SearchProvider['name']> = [
  'bing',
  'duckduckgo',
  'tavily'
]

/** provider 实例注册表 */
const PROVIDER_REGISTRY: Record<string, SearchProvider> = {
  bing: bingProvider,
  duckduckgo: duckduckgoProvider,
  tavily: tavilyProvider
}

/**
 * 返回当前可用的 provider 列表，按 fallback 顺序排列。
 * isAvailable() 为 false 的 provider 被跳过。
 */
export function getAvailableProviders(): SearchProvider[] {
  return SEARCH_PROVIDER_ORDER
    .map(name => PROVIDER_REGISTRY[name])
    .filter((p): p is SearchProvider => p !== undefined && p.isAvailable())
}
