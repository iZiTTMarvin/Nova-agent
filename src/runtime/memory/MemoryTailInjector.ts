/**
 * L2 检索记忆尾部注入：extractUserIntent → search → snippet 格式化 → context hook 追加。
 * L2 只经 context hook 落到 chatMessages 尾部，不进 system prompt / SessionStore。
 *
 * 注意：L2 自动注入已停用（2026-07），检索能力已移至 memory_search 工具。
 * 本文件保留格式化/snippet 工具函数，供 memory_search 与测试复用。
 */
import type { ChatMessage } from '../model/types'
import type { HookHandler } from '../agent/core/HookManager'
import {
  applyL2Budget,
  DEFAULT_L2_MAX_CHARS,
  DEFAULT_L2_SNIPPET_MAX_CHARS,
  L2_HIT_SEPARATOR
} from './MemoryBudget'
import { sanitizeTrigramQuery, TRIGRAM_MIN_QUERY_LEN } from './FtsQueryBuilder'
import { truncateAtLineOrHeaderBoundary } from './truncateEssence'
import type { MemorySearchHit } from './types'

/** L2 尾部块标题（与 L1「Project Memory」区分） */
export const L2_BLOCK_TITLE = 'Relevant Memory'

export interface ExtractUserIntentInput {
  /** 本轮用户输入（不含 modeInstruction） */
  currentUserText: string
  /** 最近 1–2 条 user 消息正文（不含本轮） */
  recentUserMessages?: string[]
  /** 会话标题（侧边栏） */
  sessionTitle?: string | null
}

/**
 * 拼接 FTS 查询串：会话标题 + 最近 user 消息 + 本轮输入。
 * 长串走 trigram 整串 MATCH，提升中文子串召回。
 */
export function extractUserIntent(input: ExtractUserIntentInput): string {
  const parts: string[] = []
  const title = input.sessionTitle?.trim()
  if (title) {
    parts.push(title)
  }
  for (const msg of (input.recentUserMessages ?? []).slice(-2)) {
    const t = msg.trim()
    if (t) {
      parts.push(t)
    }
  }
  const current = input.currentUserText.trim()
  if (current) {
    parts.push(current)
  }
  return parts.join('\n')
}

const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/

/**
 * 从完整意图串中抽取 FTS 查询子串：优先末行（本轮输入），避免标题/英文稀释 trigram 召回
 */
export function buildSearchQueryFromIntent(intent: string): string {
  const lines = intent
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (CJK_RE.test(line) && sanitizeTrigramQuery(line).length >= TRIGRAM_MIN_QUERY_LEN) {
      return line
    }
  }
  const cleaned = sanitizeTrigramQuery(intent)
  if (cleaned.length >= TRIGRAM_MIN_QUERY_LEN) {
    return cleaned
  }
  return intent.trim()
}

/**
 * 从命中正文提取片段（非整篇 body）：优先围绕 query 子串，否则行/标题边界截断
 */
export function extractMemorySnippet(
  body: string,
  query: string,
  maxChars = DEFAULT_L2_SNIPPET_MAX_CHARS
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

/**
 * 将检索命中格式化为 L2 尾部块正文（snippet，非整篇 body）
 */
export function buildL2TailBlock(
  hits: MemorySearchHit[],
  query: string,
  maxChars = DEFAULT_L2_MAX_CHARS
): string {
  if (hits.length === 0) {
    return ''
  }

  const headerParts = [`=== ${L2_BLOCK_TITLE} ===`]
  const q = query.trim()
  if (q) {
    headerParts.push(`Query: ${q}`)
  }
  let block = headerParts.join('\n')

  for (const hit of hits) {
    const snippet = extractMemorySnippet(hit.body, query)
    if (!snippet) {
      continue
    }
    const section = `${L2_HIT_SEPARATOR}[${hit.relPath}]\n${snippet}`
    const candidate = block + section
    if (candidate.length > maxChars) {
      break
    }
    block = candidate
  }

  return applyL2Budget(block, maxChars)
}

/** 将 L2 正文包装为追加到 messages 尾部的 user 消息 */
export function buildL2ContextMessage(l2Content: string): ChatMessage | null {
  const trimmed = l2Content.trim()
  if (!trimmed) {
    return null
  }
  return { role: 'user', content: trimmed, skipCacheMarker: true }
}

/**
 * 创建 context hook：基于原始 payload 尾部追加 L2（last-writer-wins 契约）
 */
export function createMemoryContextHook(
  l2Message: ChatMessage
): HookHandler<'context'> {
  return (payload) => ({
    messages: [...payload.messages, l2Message]
  })
}
