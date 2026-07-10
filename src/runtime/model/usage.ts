/**
 * Token 用量归一化
 * 统一 OpenAI / DeepSeek / Kimi / Anthropic 等 provider 的 usage 字段差异，
 * 输出标准化的 NormalizedUsage 结构
 */
import type { NormalizedUsage } from './types'

/**
 * 从原始 SSE chunk 的 usage 对象中提取归一化的 token 用量。
 *
 * 缓存命中字段解析优先级：
 * 1. 标准嵌套：prompt_tokens_details.cached_tokens（OpenAI）
 * 2. provider 顶层兼容：DeepSeek prompt_cache_hit_tokens / Kimi cached_tokens / Anthropic cache_read_input_tokens
 * 3. 回退 0
 *
 * 拿不到的字段一律回退为 0（cacheMissTokens 无则 undefined），不抛错。
 */
export function normalizeUsage(raw: Record<string, unknown> | undefined | null): NormalizedUsage | null {
  if (!raw) return null

  const promptTokens = toNumber(raw.prompt_tokens)
  const completionTokens = toNumber(raw.completion_tokens)

  if (promptTokens === 0 && completionTokens === 0) return null

  const cachedTokens = extractCachedTokens(raw)
  const cacheWriteTokens = extractCacheWriteTokens(raw)
  const cacheMissTokens = extractCacheMissTokens(raw)

  const result: NormalizedUsage = {
    promptTokens,
    completionTokens,
    cachedTokens,
    cacheWriteTokens
  }
  // 仅在 provider 确有 miss 字段时带上，避免把「未报告」伪装成 0
  if (cacheMissTokens !== undefined) {
    result.cacheMissTokens = cacheMissTokens
  }
  return result
}

/**
 * 提取缓存命中 token。
 * 嵌套字段一旦存在（含 0）即优先，不再回退到顶层兼容字段。
 */
function extractCachedTokens(raw: Record<string, unknown>): number {
  // 1. OpenAI 标准嵌套路径 —— 字段存在即优先（含 0）
  const details = raw.prompt_tokens_details as Record<string, unknown> | undefined
  if (details && 'cached_tokens' in details) {
    return toNumber(details.cached_tokens)
  }

  // 2. provider 顶层兼容字段（按常见冲突顺序：DeepSeek → Kimi → Anthropic）
  if ('prompt_cache_hit_tokens' in raw) {
    return toNumber(raw.prompt_cache_hit_tokens)
  }
  if ('cached_tokens' in raw) {
    // Kimi 顶层 cached_tokens：仅作嵌套缺失时的回退
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
