/**
 * reasoning 来源兼容性：只回传与当前档案同源的历史 thinking。
 * 无来源字段的旧数据视为兼容，保持既有行为。
 */
export function isReasoningSourceCompatible(
  sourceProviderId: string | undefined,
  currentProviderId: string
): boolean {
  if (!sourceProviderId) return true
  return sourceProviderId === currentProviderId
}
