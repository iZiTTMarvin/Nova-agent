/**
 * Token 用量归一化
 * 统一 OpenAI / DeepSeek / Kimi / Anthropic 等 provider 的 usage 字段差异，
 * 输出标准化四元组 + 兼容别名。
 */
import type { CacheCountReport, NormalizedUsage, UsageDialect } from './types'
import type { ChatRequestPurpose } from '../../shared/model/types'
import { cacheCountCoverageBucket } from '../../shared/model/types'
import type { UsageReportMetricFields } from '../../shared/diagnostics/metrics'

/**
 * 从原始 SSE chunk 的 usage 对象中提取归一化的 token 用量。
 *
 * 四元组派生：
 * - OpenAI / GLM / Kimi：uncached = prompt_tokens - cached_tokens
 * - DeepSeek：有 prompt_cache_miss_tokens 时优先作 uncached
 * - Anthropic 原生：兼容 input_tokens / output_tokens；uncached = input_tokens
 *
 * 拿不到的数值字段一律回退为 0（cacheMissTokens 无则 undefined），不抛错。
 * 缓存命中计数另以 cacheReadReport 标注是「明确报告」还是「字段缺失」，
 * 缺失时的 0 只是占位，消费者不得当作已确认的零命中。
 */
export function normalizeUsage(raw: unknown): NormalizedUsage | null {
  if (!isUsageRecord(raw)) return null

  const dialect = detectUsageDialect(raw)
  const cacheRead = extractCachedTokens(raw)
  const cacheReadTokens = cacheRead.tokens
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
    cacheReadReport: cacheRead.report,
    promptTokens: promptTokensAlias,
    completionTokens: outputTokens,
    cachedTokens: cacheReadTokens
  }
  if (cacheMissTokens !== undefined) {
    result.cacheMissTokens = cacheMissTokens
  }
  return result
}

function isUsageRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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
 * 提取缓存命中 token 及其上报状态。
 * 嵌套字段一旦存在（含 0）即优先，不再回退到顶层兼容字段。
 * 所有候选字段都不存在时 report 为 'unreported'，tokens 的 0 只是占位。
 */
function extractCachedTokens(raw: Record<string, unknown>): {
  tokens: number
  report: CacheCountReport
} {
  const details = raw.prompt_tokens_details
  if (details && typeof details === 'object' && 'cached_tokens' in details) {
    return cacheCount(details.cached_tokens)
  }

  if ('prompt_cache_hit_tokens' in raw) {
    return cacheCount(raw.prompt_cache_hit_tokens)
  }
  if ('cached_tokens' in raw) {
    return cacheCount(raw.cached_tokens)
  }
  if ('cache_read_input_tokens' in raw) {
    return cacheCount(raw.cache_read_input_tokens)
  }

  return { tokens: 0, report: 'unreported' }
}

function cacheCount(value: unknown): { tokens: number; report: CacheCountReport } {
  const number = typeof value === 'number' ? value
    : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN
  return Number.isFinite(number) && number >= 0
    ? { tokens: number, report: 'reported' }
    : { tokens: 0, report: 'unreported' }
}

/** 提取缓存写入 token（Anthropic cache_creation / 嵌套 cache_write_tokens） */
function extractCacheWriteTokens(raw: Record<string, unknown>): number {
  if ('cache_creation_input_tokens' in raw) {
    return toNumber(raw.cache_creation_input_tokens)
  }

  const details = raw.prompt_tokens_details
  if (details && typeof details === 'object' && 'cache_write_tokens' in details) {
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

/**
 * 把一条 usage（或其缺失）压成观测指标字段（唯一实现，主对话与压缩消费者共用）。
 *
 * usage 为 null 表示模型未报告：省略数值、usageReport='missing'、覆盖归类 'unreported'。
 * 这是「未观测到」，不是「用量为 0」，也不是「未产生费用」。
 */
export function toUsageReportMetric(
  usage: NormalizedUsage | null,
  opts: {
    logicalRequestId: string
    purpose: ChatRequestPurpose
    routeId: string
  }
): UsageReportMetricFields {
  const base = {
    logicalRequestId: opts.logicalRequestId,
    purpose: opts.purpose,
    routeId: opts.routeId
  }
  if (!usage) {
    return {
      ...base,
      usageReport: 'missing',
      cacheCountCoverage: 'unreported'
    }
  }
  return {
    ...base,
    usageReport: 'reported',
    cacheCountCoverage: cacheCountCoverageBucket(usage),
    promptTokens: usage.promptTokens,
    ...(usage.cacheReadReport === 'reported' ? { cacheReadTokens: usage.cacheReadTokens } : {}),
    cacheWriteTokens: usage.cacheWriteTokens,
    outputTokens: usage.outputTokens
  }
}
