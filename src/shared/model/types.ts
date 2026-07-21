/**
 * 归一化后的 token 用量统计。
 * 内部统一四元组；promptTokens / completionTokens / cachedTokens 为兼容别名。
 */
export type UsageDialect = 'openai' | 'deepseek' | 'anthropic' | 'unknown'

export interface NormalizedUsage {
  /** 未命中缓存的输入 */
  uncachedInputTokens: number
  /** 缓存命中读取 */
  cacheReadTokens: number
  /** 缓存写入（Anthropic 有价，其他常为 0） */
  cacheWriteTokens: number
  /** 输出 */
  outputTokens: number
  /** 原始 usage 对象，网关字段语义异常时可回查 */
  rawUsage: Record<string, unknown>
  /** 归一化时判定的字段方言 */
  usageDialect: UsageDialect
  /**
   * DeepSeek 等显式返回的 miss 字段。
   * optional：多数 provider 不返回，不能把「未报告」伪装成 0。
   */
  cacheMissTokens?: number

  /**
   * 兼容别名：uncachedInputTokens + cacheReadTokens（OpenAI 口径总输入）。
   * Anthropic 原生：input_tokens + cache_read_input_tokens。
   */
  promptTokens: number
  /** 兼容别名：= outputTokens */
  completionTokens: number
  /** 兼容别名：= cacheReadTokens */
  cachedTokens: number
}

/**
 * 统一命中率：cacheRead / (uncached + cacheRead + cacheWrite)。
 * 所有 provider 下天然 ≤ 1。
 */
export function computeCacheHitRate(parts: {
  uncachedInputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}): number {
  const denom =
    parts.uncachedInputTokens + parts.cacheReadTokens + parts.cacheWriteTokens
  return denom > 0 ? parts.cacheReadTokens / denom : 0
}
