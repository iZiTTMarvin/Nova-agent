/**
 * 记忆注入字符预算：L1 / L2 分路径裁剪，禁止合并为单一函数塞进 system prompt。
 */
import { truncateAtLineOrHeaderBoundary } from './truncateEssence'

/** L1（system prompt 层）默认字符上限 */
export const DEFAULT_L1_MAX_CHARS = 3200

/** L2（context hook 尾部块）默认字符上限 */
export const DEFAULT_L2_MAX_CHARS = 6000

/** L2 单条命中片段默认字符上限（buildL2TailBlock 内使用） */
export const DEFAULT_L2_SNIPPET_MAX_CHARS = 400

/**
 * 裁剪 L1 精华文本（行/标题边界优先；首行即超长时硬切兜底，避免 L1 静默消失）
 */
export function applyL1Budget(text: string, maxChars = DEFAULT_L1_MAX_CHARS): string {
  const trimmed = text.trim()
  if (!trimmed || trimmed.length <= maxChars) {
    return trimmed
  }
  const truncated = truncateAtLineOrHeaderBoundary(trimmed, maxChars)
  if (truncated.trim()) {
    return truncated
  }
  return trimmed.slice(0, maxChars)
}

/** L2 命中块之间的分隔符（applyL2Budget 在块边界裁剪） */
export const L2_HIT_SEPARATOR = '\n\n---\n\n'

/**
 * 裁剪 L2 尾部块：优先在命中块分隔处截断，避免半条片段
 */
export function applyL2Budget(text: string, maxChars = DEFAULT_L2_MAX_CHARS): string {
  const trimmed = text.trim()
  if (!trimmed || trimmed.length <= maxChars) {
    return trimmed
  }
  let cut = trimmed.slice(0, maxChars)
  const lastSep = cut.lastIndexOf(L2_HIT_SEPARATOR)
  if (lastSep > 0) {
    cut = cut.slice(0, lastSep)
  }
  return cut.trimEnd()
}
