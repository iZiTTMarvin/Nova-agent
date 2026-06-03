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
  /** 模型最大上下文窗口（tokens），未设置时从 modelId 自动推断 */
  contextWindow?: number
}

/** 从 baseUrl 推断默认缓存策略 */
export function inferCacheStrategy(baseUrl: string): CacheStrategy {
  const lower = baseUrl.toLowerCase()
  if (lower.includes('anthropic') || lower.includes('claude')) {
    return 'anthropic'
  }
  return 'auto'
}

/** 默认上下文窗口上限 */
const DEFAULT_CONTEXT_WINDOW = 200_000

/** 基于常见模型 ID 自动推断上下文窗口上限 */
export function inferContextWindow(modelId: string): number {
  const lower = modelId.toLowerCase()
  if (lower.includes('claude-3-opus')) return 200_000
  if (lower.includes('claude-3-5')) return 200_000
  if (lower.includes('claude-3')) return 200_000
  if (lower.includes('gpt-4o')) return 128_000
  if (lower.includes('gpt-4-turbo')) return 128_000
  if (lower.includes('gpt-4')) return 128_000
  if (lower.includes('deepseek')) return 64_000
  return DEFAULT_CONTEXT_WINDOW
}
