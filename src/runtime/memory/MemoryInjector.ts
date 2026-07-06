/**
 * L1 项目记忆注入：将 getProjectEssence 原文转为 system prompt 的 memoryContext 层文本。
 * L1 只进 system prompt，不经 context hook。
 */
import { applyL1Budget, DEFAULT_L1_MAX_CHARS } from './MemoryBudget'

/**
 * 构建 L1 memoryContext 层正文（应用 L1 预算后；空则返回 null 以跳过该层）
 */
export function buildL1MemoryContext(
  essence: string,
  maxChars = DEFAULT_L1_MAX_CHARS
): string | null {
  const budgeted = applyL1Budget(essence, maxChars)
  return budgeted.trim() ? budgeted : null
}
