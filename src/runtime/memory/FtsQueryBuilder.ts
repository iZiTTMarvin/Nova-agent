/**
 * FTS MATCH 查询构建与 BM25 结果裁剪（纯逻辑，不碰 SQLite）。
 */
import type { BuiltMatchQuery, FtsQueryPath, MemorySearchHit } from './types'

/** 默认检索条数上限 */
export const DEFAULT_SEARCH_LIMIT = 10

/** 默认相对分数阈值：score >= topScore * floor */
export const DEFAULT_SCORE_FLOOR = 0.15

/** trigram 最短有效查询长度 */
export const TRIGRAM_MIN_QUERY_LEN = 3

/** over-fetch 上限 */
export const MAX_OVER_FETCH = 50

const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/

/** 文件指纹：size-mtimeMs */
export function computeFingerprint(size: number, mtimeMs: number): string {
  return `${size}-${mtimeMs}`
}

/**
 * 计算 over-fetch 条数：limit * 3，封顶 50
 */
export function computeOverFetchLimit(limit: number): number {
  return Math.min(Math.max(limit, 1) * 3, MAX_OVER_FETCH)
}

/** 仅保留字母/数字/CJK/空白，其余替换为空格（防 FTS5 MATCH 语法错误） */
const FTS_SAFE_CHAR_RE = /[^\p{L}\p{N}\s]/gu

/**
 * 清洗 trigram 查询：白名单保留可读子串，去掉一切 FTS 特殊符与标点
 */
export function sanitizeTrigramQuery(raw: string): string {
  return raw
    .trim()
    .replace(FTS_SAFE_CHAR_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * trigram 路径：清洗后整串交 MATCH；不足 3 字符返回 null
 */
export function buildTrigramMatchQuery(raw: string): string | null {
  const cleaned = sanitizeTrigramQuery(raw)
  if (cleaned.length < TRIGRAM_MIN_QUERY_LEN) {
    return null
  }
  return cleaned
}

/**
 * unicode61 风格路径：分词后用 OR 连接；短语用双引号包裹
 */
export function buildUnicode61MatchQuery(raw: string): string | null {
  const tokens = tokenizeForUnicode61(raw)
  if (tokens.length === 0) {
    return null
  }
  const parts = tokens.map((t) => (t.includes(' ') ? `"${t.replace(/"/g, '')}"` : t))
  const joined = parts.join(' OR ')
  if (joined.replace(/\s|OR|"/g, '').length < TRIGRAM_MIN_QUERY_LEN) {
    return null
  }
  return joined
}

function tokenizeForUnicode61(raw: string): string[] {
  const tokens: string[] = []
  let stripped = raw.trim()
  const phraseRe = /"([^"]+)"/g
  let m: RegExpExecArray | null
  while ((m = phraseRe.exec(raw)) !== null) {
    const phrase = sanitizeTrigramQuery(m[1])
    if (phrase) {
      tokens.push(phrase)
    }
    stripped = stripped.replace(m[0], ' ')
  }
  const normalized = stripped.replace(FTS_SAFE_CHAR_RE, ' ')
  for (const word of normalized.split(/\s+/)) {
    const w = word.trim()
    if (w.length > 0) {
      tokens.push(w)
    }
  }
  return tokens
}

function hasSignificantCjk(text: string): boolean {
  return CJK_RE.test(text)
}

/**
 * 双分派：含显著 CJK → trigram 整串；否则 unicode61 OR 路径
 */
export function buildMatchQuery(raw: string): BuiltMatchQuery {
  const trimmed = raw.trim()
  if (!trimmed) {
    return { query: null, path: 'none' }
  }

  if (hasSignificantCjk(trimmed)) {
    const query = buildTrigramMatchQuery(trimmed)
    return { query, path: query ? 'trigram' : 'none' }
  }

  const query = buildUnicode61MatchQuery(trimmed)
  return { query, path: query ? 'unicode61' : 'none' }
}

/**
 * BM25 取负后的分数裁剪：top1 恒留，其余需 score >= topScore * floor
 */
export function applyScoreFloor(
  hits: MemorySearchHit[],
  limit: number,
  scoreFloor: number
): MemorySearchHit[] {
  if (hits.length === 0 || limit <= 0) {
    return []
  }
  const topScore = hits[0].score
  const threshold = topScore * scoreFloor
  const kept: MemorySearchHit[] = []
  for (let i = 0; i < hits.length; i++) {
    const hit = hits[i]
    if (i === 0 || hit.score >= threshold) {
      kept.push(hit)
    }
  }
  return kept.slice(0, limit)
}

/** 将原始 bm25（负值，越小越好）转为 score（越大越好） */
export function negateBm25(bm25: number): number {
  return -bm25
}
