/**
 * 模型配置类型
 * 全局唯一的 OpenAI-compatible 模型配置
 */

/** 缓存策略：auto = 前缀稳定即自动命中；anthropic = 显式 cache_control 标记 */
export type CacheStrategy = 'auto' | 'anthropic'

export interface ModelConfig {
  baseUrl: string
  apiKey: string
  modelId: string
  /**
   * 缓存策略。默认 'auto'。
   * 'anthropic' 适用于 Anthropic 原生 API 或中转，会对最后 2 条消息打 cache_control 标记。
   */
  cacheStrategy?: CacheStrategy
}

/** 从 baseUrl 推断默认缓存策略 */
export function inferCacheStrategy(baseUrl: string): CacheStrategy {
  const lower = baseUrl.toLowerCase()
  if (lower.includes('anthropic') || lower.includes('claude')) {
    return 'anthropic'
  }
  return 'auto'
}
