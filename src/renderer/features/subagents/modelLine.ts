import type { SubagentActivityProjection } from '../../../shared/subagents'

/**
 * 子代理「模型、思考强度」展示片段：auto/缺省的强度不展示。
 * 返回分段而非拼接字符串，由调用方用间距排版，不用中点分隔。
 * 紧凑行与悬浮面板共用，避免两处各自拼接漂移。
 */
export function formatSubagentModelParts(
  projection: Pick<SubagentActivityProjection, 'model' | 'reasoningEffort'>
): string[] {
  const parts: string[] = []
  if (projection.model) parts.push(projection.model.modelId)
  if (projection.reasoningEffort && projection.reasoningEffort !== 'auto') {
    parts.push(projection.reasoningEffort)
  }
  return parts
}
