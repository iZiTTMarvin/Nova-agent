/**
 * SearchProvider 类型 re-export 与错误工厂
 */
import type { SearchProvider, SearchProviderError } from '../types'

export type { SearchProvider, SearchProviderError }

/** SearchProviderError 的工厂函数，方便各 adapter 调用 */
export function providerError(
  provider: string,
  message: string,
  statusCode?: number
): SearchProviderError {
  return { provider: provider as SearchProviderError['provider'], message, statusCode }
}
