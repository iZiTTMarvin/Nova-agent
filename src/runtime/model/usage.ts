/**
 * Token 用量归一化
 * 统一 OpenAI / DeepSeek / Anthropic 三种 provider 的 usage 字段差异，
 * 输出标准化的 NormalizedUsage 结构
 */
import type { NormalizedUsage } from './types'

/**
 * 从原始 SSE chunk 的 usage 对象中提取归一化的 token 用量。
 *
 * 三种 provider 的缓存字段命名：
 * - OpenAI：usage.prompt_tokens_details.cached_tokens
 * - DeepSeek：usage.prompt_cache_hit_tokens / prompt_cache_miss_tokens
 * - Anthropic（中转）：cache_read_input_tokens / cache_creation_input_tokens
 *
 * 拿不到的字段一律回退为 0，不抛错。
 */
export function normalizeUsage(raw: Record<string, unknown> | undefined | null): NormalizedUsage | null {
  if (!raw) return null

  const promptTokens = toNumber(raw.prompt_tokens)
  const completionTokens = toNumber(raw.completion_tokens)

  if (promptTokens === 0 && completionTokens === 0) return null

  const cachedTokens = extractCachedTokens(raw)
  const cacheWriteTokens = extractCacheWriteTokens(raw)

  return { promptTokens, completionTokens, cachedTokens, cacheWriteTokens }
}

/** OpenAI: prompt_tokens_details.cached_tokens */
function extractCachedTokens(raw: Record<string, unknown>): number {
  // OpenAI 标准路径
  const details = raw.prompt_tokens_details as Record<string, unknown> | undefined
  if (details) {
    const cached = toNumber(details.cached_tokens)
    if (cached > 0) return cached
  }

  // DeepSeek 路径
  const deepseekHit = toNumber(raw.prompt_cache_hit_tokens)
  if (deepseekHit > 0) return deepseekHit

  // Anthropic 中转路径
  const anthropicRead = toNumber(raw.cache_read_input_tokens)
  if (anthropicRead > 0) return anthropicRead

  return 0
}

function extractCacheWriteTokens(raw: Record<string, unknown>): number {
  const anthropicWrite = toNumber(raw.cache_creation_input_tokens)
  if (anthropicWrite > 0) return anthropicWrite

  const details = raw.prompt_tokens_details as Record<string, unknown> | undefined
  if (details) {
    const write = toNumber(details.cache_write_tokens)
    if (write > 0) return write
  }

  return 0
}

function toNumber(val: unknown): number {
  if (typeof val === 'number' && Number.isFinite(val)) return val
  if (typeof val === 'string') {
    const n = Number(val)
    return Number.isFinite(n) ? n : 0
  }
  return 0
}
