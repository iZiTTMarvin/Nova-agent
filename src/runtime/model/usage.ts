/**
 * Token 用量归一化
 * 统一 OpenAI / DeepSeek / Kimi / Anthropic 等 provider 的 usage 字段差异，
 * 输出标准化四元组 + 兼容别名。
 */
import type { NormalizedUsage, UsageDialect } from './types'

/**
 * 从原始 SSE chunk 的 usage 对象中提取归一化的 token 用量。
 *
 * 四元组派生：
 * - OpenAI / GLM / Kimi：uncached = prompt_tokens - cached_tokens
 * - DeepSeek：有 prompt_cache_miss_tokens 时优先作 uncached
 * - Anthropic 原生：兼容 input_tokens / output_tokens；uncached = input_tokens
 *
 * 拿不到的字段一律回退为 0（cacheMissTokens 无则 undefined），不抛错。
 */
export function normalizeUsage(raw: Record<string, unknown> | undefined | null): NormalizedUsage | null {
  if (!raw) return null

  const dialect = detectUsageDialect(raw)
  const cacheReadTokens = extractCachedTokens(raw)
  const cacheWriteTokens = extractCacheWriteTokens(raw)
  const cacheMissTokens = extractCacheMissTokens(raw)

  let uncachedInputTokens: number
  let outputTokens: number
  let promptTokensAlias: number

  if (dialect === 'anthropic') {
    // Anthropic：input_tokens 不含 cache_read；output_tokens 为输出
    const inputTokens = toNumber(raw.input_tokens)
    outputTokens = toNumber(raw.output_tokens)
    uncachedInputTokens = inputTokens
    promptTokensAlias = inputTokens + cacheReadTokens
    if (promptTokensAlias === 0 && outputTokens === 0 && cacheWriteTokens === 0) {
      return null
    }
  } else {
    const promptTokens = toNumber(raw.prompt_tokens)
    outputTokens = toNumber(raw.completion_tokens)
    if (promptTokens === 0 && outputTokens === 0) return null

    if (cacheMissTokens !== undefined) {
      uncachedInputTokens = cacheMissTokens
    } else {
      uncachedInputTokens = Math.max(0, promptTokens - cacheReadTokens)
    }
    promptTokensAlias = promptTokens
  }

  const result: NormalizedUsage = {
    uncachedInputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    outputTokens,
    rawUsage: { ...raw },
    usageDialect: dialect,
    promptTokens: promptTokensAlias,
    completionTokens: outputTokens,
    cachedTokens: cacheReadTokens
  }
  if (cacheMissTokens !== undefined) {
    result.cacheMissTokens = cacheMissTokens
  }
  return result
}

function detectUsageDialect(raw: Record<string, unknown>): UsageDialect {
  // 纯 Anthropic 原生：有 input_tokens、无 prompt_tokens
  if ('input_tokens' in raw && !('prompt_tokens' in raw)) {
    return 'anthropic'
  }
  if ('prompt_cache_hit_tokens' in raw || 'prompt_cache_miss_tokens' in raw) {
    return 'deepseek'
  }
  if ('prompt_tokens' in raw || 'completion_tokens' in raw) {
    return 'openai'
  }
  if ('input_tokens' in raw) return 'anthropic'
  return 'unknown'
}

/**
 * 提取缓存命中 token。
 * 嵌套字段一旦存在（含 0）即优先，不再回退到顶层兼容字段。
 */
function extractCachedTokens(raw: Record<string, unknown>): number {
  const details = raw.prompt_tokens_details as Record<string, unknown> | undefined
  if (details && 'cached_tokens' in details) {
    return toNumber(details.cached_tokens)
  }

  if ('prompt_cache_hit_tokens' in raw) {
    return toNumber(raw.prompt_cache_hit_tokens)
  }
  if ('cached_tokens' in raw) {
    return toNumber(raw.cached_tokens)
  }
  if ('cache_read_input_tokens' in raw) {
    return toNumber(raw.cache_read_input_tokens)
  }

  return 0
}

/** 提取缓存写入 token（Anthropic cache_creation / 嵌套 cache_write_tokens） */
function extractCacheWriteTokens(raw: Record<string, unknown>): number {
  if ('cache_creation_input_tokens' in raw) {
    return toNumber(raw.cache_creation_input_tokens)
  }

  const details = raw.prompt_tokens_details as Record<string, unknown> | undefined
  if (details && 'cache_write_tokens' in details) {
    return toNumber(details.cache_write_tokens)
  }

  return 0
}

/**
 * 提取缓存未命中 token（DeepSeek prompt_cache_miss_tokens）。
 * 字段不存在时返回 undefined，与「报告为 0」区分。
 */
function extractCacheMissTokens(raw: Record<string, unknown>): number | undefined {
  if (!('prompt_cache_miss_tokens' in raw)) return undefined
  return toNumber(raw.prompt_cache_miss_tokens)
}

function toNumber(val: unknown): number {
  if (typeof val === 'number' && Number.isFinite(val)) return val
  if (typeof val === 'string') {
    const n = Number(val)
    return Number.isFinite(n) ? n : 0
  }
  return 0
}

export { computeCacheHitRate } from '../../shared/model/types'
