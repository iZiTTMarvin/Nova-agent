import {
  addCacheCountCoverage, cacheCountCoverageBucket, computeCacheHitRate,
  EMPTY_CACHE_COUNT_COVERAGE, mergeCacheCountCoverage,
  type CacheCountCoverage, type NormalizedUsage
} from '../model/types'

/** 会话累计的用量事实；不保存 provider 原始响应。 */
export interface SessionUsageTotals {
  uncachedInputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  outputTokens: number
  cacheMissTokens?: number
  cacheCountCoverage: CacheCountCoverage
  lastRoundHitRate: number
}

/** revision 每接收一次 usage 递增，防止加载中的旧快照覆盖实时统计。 */
export interface SessionUsageSnapshot {
  version: 1
  sessionId: string
  revision: number
  byProfile: Record<string, SessionUsageTotals>
  lastRoundHitRate: number
}

/** 展示派生值，不作为持久化真源。 */
export interface SessionUsageStats {
  cacheCountCoverage: CacheCountCoverage
  totalUncachedInputTokens: number
  totalCacheReadTokens: number
  totalCacheWriteTokens: number
  totalOutputTokens: number
  totalPromptTokens: number
  totalCompletionTokens: number
  totalCachedTokens: number
  totalCacheMissTokens?: number
  hitRate: number
  lastRoundHitRate: number
  estimatedSavedInputTokens: number
}

const EMPTY_TOTALS: SessionUsageTotals = {
  uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0,
  cacheCountCoverage: EMPTY_CACHE_COUNT_COVERAGE, lastRoundHitRate: 0
}

/** 一次用量只在持久化 Owner 累加；前台与后台会话使用同一入口。 */
export function appendSessionUsage(
  previous: SessionUsageSnapshot | null, sessionId: string,
  usage: NormalizedUsage, cacheProfileId: string
): SessionUsageSnapshot {
  if (previous && previous.sessionId !== sessionId) throw new Error('Session usage identity mismatch')
  const profile = cacheProfileId.trim() || 'unknown'
  const prior = previous && Object.hasOwn(previous.byProfile, profile) ? previous.byProfile[profile] : EMPTY_TOTALS
  const lastRoundHitRate = computeCacheHitRate(usage)
  const totals: SessionUsageTotals = {
    uncachedInputTokens: prior.uncachedInputTokens + usage.uncachedInputTokens,
    cacheReadTokens: prior.cacheReadTokens + usage.cacheReadTokens,
    cacheWriteTokens: prior.cacheWriteTokens + usage.cacheWriteTokens,
    outputTokens: prior.outputTokens + usage.outputTokens,
    cacheCountCoverage: addCacheCountCoverage(prior.cacheCountCoverage, cacheCountCoverageBucket(usage)),
    lastRoundHitRate
  }
  if (usage.cacheMissTokens !== undefined || prior.cacheMissTokens !== undefined) {
    totals.cacheMissTokens = (prior.cacheMissTokens ?? 0) + (usage.cacheMissTokens ?? 0)
  }
  return {
    version: 1, sessionId, revision: (previous?.revision ?? 0) + 1,
    byProfile: { ...previous?.byProfile, [profile]: totals }, lastRoundHitRate
  }
}

export function projectSessionUsage(snapshot: SessionUsageSnapshot | null): {
  sessionUsage: SessionUsageStats | null
  sessionUsageByProfile: Record<string, SessionUsageStats>
} {
  if (!snapshot) return { sessionUsage: null, sessionUsageByProfile: {} }
  const total: SessionUsageTotals = { ...EMPTY_TOTALS, lastRoundHitRate: snapshot.lastRoundHitRate }
  for (const bucket of Object.values(snapshot.byProfile)) {
    total.uncachedInputTokens += bucket.uncachedInputTokens
    total.cacheReadTokens += bucket.cacheReadTokens
    total.cacheWriteTokens += bucket.cacheWriteTokens
    total.outputTokens += bucket.outputTokens
    total.cacheCountCoverage = mergeCacheCountCoverage(total.cacheCountCoverage, bucket.cacheCountCoverage)
    if (bucket.cacheMissTokens !== undefined) total.cacheMissTokens = (total.cacheMissTokens ?? 0) + bucket.cacheMissTokens
  }
  return {
    sessionUsage: toStats(total),
    sessionUsageByProfile: Object.fromEntries(Object.entries(snapshot.byProfile).map(([id, totals]) => [id, toStats(totals)]))
  }
}

function toStats(totals: SessionUsageTotals): SessionUsageStats {
  return {
    cacheCountCoverage: { ...totals.cacheCountCoverage },
    totalUncachedInputTokens: totals.uncachedInputTokens,
    totalCacheReadTokens: totals.cacheReadTokens,
    totalCacheWriteTokens: totals.cacheWriteTokens,
    totalOutputTokens: totals.outputTokens,
    totalPromptTokens: totals.uncachedInputTokens + totals.cacheReadTokens,
    totalCompletionTokens: totals.outputTokens, totalCachedTokens: totals.cacheReadTokens,
    ...(totals.cacheMissTokens !== undefined ? { totalCacheMissTokens: totals.cacheMissTokens } : {}),
    hitRate: computeCacheHitRate(totals), lastRoundHitRate: totals.lastRoundHitRate,
    estimatedSavedInputTokens: totals.cacheReadTokens
  }
}

/** 旧会话没有独立用量文件；已存在但损坏或版本未知的文件必须显式报错，不能清零覆盖。 */
export function decodeSessionUsage(value: unknown, sessionId: string): SessionUsageSnapshot {
  const invalid = (): never => { throw new Error('Invalid session usage snapshot') }
  const object = (input: unknown): Record<string, unknown> => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return invalid()
    return input as Record<string, unknown>
  }
  const count = (input: unknown): number => {
    if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < 0) return invalid()
    return input
  }
  const rate = (input: unknown): number => {
    if (typeof input !== 'number' || !Number.isFinite(input) || input < 0 || input > 1) return invalid()
    return input
  }
  const raw = object(value)
  if (raw.version !== 1 || raw.sessionId !== sessionId) return invalid()
  const revision = count(raw.revision)
  const entries = Object.entries(object(raw.byProfile)).map(([id, input]): [string, SessionUsageTotals] => {
    if (!id.trim()) return invalid()
    const bucket = object(input)
    const coverage = object(bucket.cacheCountCoverage)
    return [id, {
      uncachedInputTokens: count(bucket.uncachedInputTokens), cacheReadTokens: count(bucket.cacheReadTokens),
      cacheWriteTokens: count(bucket.cacheWriteTokens), outputTokens: count(bucket.outputTokens),
      ...(bucket.cacheMissTokens !== undefined ? { cacheMissTokens: count(bucket.cacheMissTokens) } : {}),
      cacheCountCoverage: { reportedPositive: count(coverage.reportedPositive), reportedZero: count(coverage.reportedZero), unreported: count(coverage.unreported) },
      lastRoundHitRate: rate(bucket.lastRoundHitRate)
    }]
  })
  const reports = entries.reduce((sum, [, b]) => sum + b.cacheCountCoverage.reportedPositive + b.cacheCountCoverage.reportedZero + b.cacheCountCoverage.unreported, 0)
  if (revision === 0 || reports !== revision) return invalid()
  return { version: 1, sessionId, revision, byProfile: Object.fromEntries(entries), lastRoundHitRate: rate(raw.lastRoundHitRate) }
}
