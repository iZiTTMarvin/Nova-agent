/**
 * 归一化后的 token 用量统计。
 * 内部统一四元组；promptTokens / completionTokens / cachedTokens 为兼容别名。
 */
export type UsageDialect = 'openai' | 'deepseek' | 'anthropic' | 'unknown'

/**
 * 模型请求用途（唯一类型来源）。
 * 用于诊断与观测按来源分账，不影响请求构造，也不豁免缓存告警。
 * 压缩的 stub / state / tighten 是三个不同的逻辑请求，不得合并成一类。
 */
export type ChatRequestPurpose =
  | 'main'
  | 'compaction-stub'
  | 'compaction-state'
  | 'compaction-tighten'

/**
 * 供应商缓存计数的上报状态。
 * - 'reported'：响应明确给出缓存计数字段，值可以是 0；
 * - 'unreported'：字段缺失，归一化后的 0 只是占位，不得解读为「已确认全部未命中」。
 */
export type CacheCountReport = 'reported' | 'unreported'

/**
 * 模型是否在本次响应中报告了 usage。
 * 'missing' 常见于取消、中段失败或未开启 include_usage 的网关；不得按 0 用量解读，
 * 也不能因此断定该请求没有产生费用。
 */
export type UsageReport = 'reported' | 'missing'

/** usage 的物理来源；用于连接供应商报告与应用消费账。 */
export interface UsageSource {
  logicalRequestId: string
  physicalAttemptId: string
  routeId: string
  purpose: ChatRequestPurpose
}

/** 缓存计数字段覆盖的三种归类；缺失必须单列，不得按 0 混入命中统计解释。 */
export type CacheCountCoverageBucket = 'reportedZero' | 'reportedPositive' | 'unreported'

/** 会话内缓存计数的字段覆盖统计。 */
export interface CacheCountCoverage {
  /** 明确报告缓存计数为 0 的 usage 条数 */
  reportedZero: number
  /** 明确报告缓存计数为正的 usage 条数 */
  reportedPositive: number
  /** 缺少缓存计数字段的 usage 条数 */
  unreported: number
}

export const EMPTY_CACHE_COUNT_COVERAGE: CacheCountCoverage = {
  reportedZero: 0,
  reportedPositive: 0,
  unreported: 0
}

/** 把单条 usage 归入字段覆盖分类（唯一实现，供各消费者复用）。 */
export function cacheCountCoverageBucket(usage: NormalizedUsage): CacheCountCoverageBucket {
  if (usage.cacheReadReport === 'unreported') return 'unreported'
  return usage.cacheReadTokens > 0 ? 'reportedPositive' : 'reportedZero'
}

/** 累加一条 usage 到已有字段覆盖统计。 */
export function addCacheCountCoverage(
  prev: CacheCountCoverage,
  bucket: CacheCountCoverageBucket
): CacheCountCoverage {
  return { ...prev, [bucket]: prev[bucket] + 1 }
}

/** 合并多份字段覆盖统计（分桶汇总用）。 */
export function mergeCacheCountCoverage(
  a: CacheCountCoverage,
  b: CacheCountCoverage
): CacheCountCoverage {
  return {
    reportedZero: a.reportedZero + b.reportedZero,
    reportedPositive: a.reportedPositive + b.reportedPositive,
    unreported: a.unreported + b.unreported
  }
}

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
   * cacheReadTokens 的上报状态。
   * 'unreported' 时 cacheReadTokens 的 0 只是归一化占位，消费者不得据此判定「缓存未命中」，
   * 也不得把该请求当作已确认的 0 命中计入命中率解释。
   */
  cacheReadReport: CacheCountReport

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
