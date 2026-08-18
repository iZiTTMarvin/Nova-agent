/**
 * 记忆预算常量：检索/prefetch 注入的条数与字符上限集中于此，禁止散落魔法数字。
 * 这些数值是行为契约的一部分：调整会改变注入块形状与检索截断，须连同相关测试评估。
 */
import { truncateAtLineOrHeaderBoundary } from './truncateEssence'

// ---------------------------------------------------------------------------
// prefetch 动态注入预算（PRD 18.2）
// ---------------------------------------------------------------------------

/** 动态记忆注入块总字符上限 */
export const MEMORY_PREFETCH_TOTAL_MAX_CHARS = 2400

/** 单条 structured 记忆注入字符上限 */
export const MEMORY_PREFETCH_STRUCTURED_MAX_CHARS = 320

/** project structured 记忆注入条数上限 */
export const MEMORY_PREFETCH_PROJECT_STRUCTURED_MAX_ITEMS = 4

/** global 记忆注入条数上限 */
export const MEMORY_PREFETCH_GLOBAL_MAX_ITEMS = 2

/** 手写文档 / episodic 命中注入条数上限 */
export const MEMORY_PREFETCH_DOCUMENT_MAX_ITEMS = 2

/** prefetch 候选拉取条数（组合层送入排序的池大小） */
export const MEMORY_PREFETCH_CANDIDATE_LIMIT = 12

/** prefetch 相关性下限（相对池内 top 的比例；低于此比例的尾部队不注入） */
export const MEMORY_PREFETCH_SCORE_FLOOR = 0.25

// ---------------------------------------------------------------------------
// 旧文档注入路径（L1 system prompt / L2 尾部块）的字符预算。
// 仅供 MemoryService / MemoryInjector / MemoryTailInjector 消费；动态记忆
// 接线完成后随文档注入路径一并删除，届时不得保留无调用方的导出。
// ---------------------------------------------------------------------------

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
