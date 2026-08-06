/**
 * 上下文溢出检测
 *
 * 判定顺序：先否决（限速 / 配额 / 输出侧 token 超限），再正向匹配。
 * 否决命中即非溢出，避免误触发 aggressive compaction。
 */

const STRONG_PHRASES = [
  'context length',
  'context_length_exceeded',
  'maximum context',
  'maximum input length',
  'prompt is too long',
  'input is too long',
  'exceeds the maximum context',
  "exceeds the model's context",
  "exceeds the model's maximum",
  'reduce the length of the input',
  'reduce the length of the messages',
  'reduce the length of your',
  'reduce the length of the prompt',
  'range of input length',
]

/**
 * 形似 token 相关、实为限速/配额/输出侧超限的否决模式。
 * 输出侧组合覆盖 role 与 predicate 的常见语序排列。
 */
const NON_CONTEXT_OVERFLOW_PATTERNS: readonly RegExp[] = [
  /rate limit/i,
  /too many requests/i,
  /throttl/i,
  /quota/i,
  /(?:output|completion|max_tokens)\b[^.]{0,60}(?:too many tokens|token limit exceeded)/i,
  /(?:too many tokens|token limit exceeded)[^.]{0,60}\b(?:output|completion|max_tokens)/i,
  /(?:output|completion)\s+token\s+(?:count|limit)[^.]{0,40}exceed/i,
  /too many (?:output|completion|max_tokens)[^.]{0,20}tokens/i,
  /\b(?:output|completion|max_tokens)\s+tokens?\b[^.]{0,20}exceed/i,
]

/**
 * 判断 API 响应错误是否为上下文超限（Context Overflow）
 *
 * - 只对 HTTP 400 状态码进行错误消息匹配
 * - 先否决、后正向；命中否决即返回非溢出
 */
export function isContextOverflowError(statusCode: number, errorBody: string): boolean {
  if (statusCode !== 400) return false
  const msg = errorBody.toLowerCase()

  if (NON_CONTEXT_OVERFLOW_PATTERNS.some((pattern) => pattern.test(msg))) return false

  if (STRONG_PHRASES.some(p => msg.includes(p))) return true

  // Anthropic: "<N> tokens > <N> maximum"
  if (/\d+\s*tokens?[\s\S]*>\s*\d+/.test(msg)) return true

  if (msg.includes('parameter=input_tokens')) return true

  return false
}
