import type { MemorySearchHit } from './types'

export const DEFAULT_SEARCH_LIMIT = 10
export const DEFAULT_SCORE_FLOOR = 0.15
export const MAX_OVER_FETCH = 50

export function computeFingerprint(size: number, mtimeMs: number): string { return `${size}-${mtimeMs}` }
export function computeOverFetchLimit(limit: number): number { return Math.min(Math.max(limit, 1) * 3, MAX_OVER_FETCH) }

/** Snippet 查询清洗保留可读文本，查询分词由 indexTerms 负责。 */
export function sanitizeTrigramQuery(raw: string): string {
  return raw.trim().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim()
}

export function applyScoreFloor(hits: MemorySearchHit[], limit: number, scoreFloor: number): MemorySearchHit[] {
  if (!hits.length || limit <= 0) return []
  const threshold = hits[0].score * scoreFloor
  return hits.filter((hit, index) => index === 0 || hit.score >= threshold).slice(0, limit)
}

export function negateBm25(bm25: number): number { return -bm25 }
