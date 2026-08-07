import type { SubagentActivityProjection } from '../../../shared/subagents'

/**
 * 子代理「模型 · 思考强度」展示文案：auto/缺省的强度不展示。
 * 紧凑行与悬浮面板共用，避免两处各自拼接漂移。
 */
export function formatSubagentModelLine(
  projection: Pick<SubagentActivityProjection, 'model' | 'reasoningEffort'>
): string | null {
  const parts: string[] = []
  if (projection.model) parts.push(projection.model.modelId)
  if (projection.reasoningEffort && projection.reasoningEffort !== 'auto') {
    parts.push(projection.reasoningEffort)
  }
  return parts.length > 0 ? parts.join(' · ') : null
}
