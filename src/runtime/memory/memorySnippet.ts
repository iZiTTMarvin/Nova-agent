/**
 * 文档记忆片段提取：从命中正文取围绕 query 的摘录（非整篇 body）。
 * 为 memory_search 结果提取有界的相关片段。
 */
import { sanitizeTrigramQuery } from './FtsQueryBuilder'
import { truncateAtLineOrHeaderBoundary } from './truncateEssence'
import { MEMORY_SNIPPET_MAX_CHARS } from './MemoryBudget'

/**
 * 从命中正文提取片段：优先围绕 query 子串，否则行/标题边界截断
 */
export function extractMemorySnippet(
  body: string,
  query: string,
  maxChars: number = MEMORY_SNIPPET_MAX_CHARS
): string {
  const trimmed = body.trim()
  if (!trimmed) {
    return ''
  }
  if (trimmed.length <= maxChars) {
    return trimmed
  }

  const needle = pickSnippetNeedle(query)
  if (needle.length >= 3) {
    const idx = findNeedleIndex(trimmed, needle)
    if (idx >= 0) {
      return buildExcerptAround(trimmed, idx, needle.length, maxChars)
    }
  }

  const lineBounded = truncateAtLineOrHeaderBoundary(trimmed, maxChars)
  if (lineBounded.trim()) {
    return lineBounded
  }
  return trimmed.slice(0, maxChars)
}

/** 从 query 中取最适合做子串定位的片段（优先末段当前输入） */
function pickSnippetNeedle(query: string): string {
  const lines = query.split('\n').map((l) => l.trim()).filter(Boolean)
  const lastLine = lines[lines.length - 1] ?? ''
  const cleaned = sanitizeTrigramQuery(lastLine || query)
  if (cleaned.length >= 3) {
    return cleaned
  }
  return sanitizeTrigramQuery(query)
}

function findNeedleIndex(haystack: string, needle: string): number {
  const direct = haystack.indexOf(needle)
  if (direct >= 0) {
    return direct
  }
  const lowerHay = haystack.toLowerCase()
  const lowerNeedle = needle.toLowerCase()
  return lowerHay.indexOf(lowerNeedle)
}

/** 以命中位置为中心截取上下文窗口 */
function buildExcerptAround(
  text: string,
  matchIndex: number,
  matchLen: number,
  maxChars: number
): string {
  const half = Math.floor((maxChars - matchLen) / 2)
  let start = Math.max(0, matchIndex - half)
  let end = Math.min(text.length, matchIndex + matchLen + half)
  if (end - start > maxChars) {
    end = start + maxChars
  }
  if (end - start < maxChars && start > 0) {
    start = Math.max(0, end - maxChars)
  }
  let excerpt = text.slice(start, end).trim()
  if (start > 0) {
    excerpt = `…${excerpt}`
  }
  if (end < text.length) {
    excerpt = `${excerpt}…`
  }
  if (excerpt.length > maxChars) {
    excerpt = excerpt.slice(0, maxChars)
    if (!excerpt.startsWith('…')) {
      excerpt = `…${excerpt.slice(1)}`
    }
  }
  return excerpt
}
