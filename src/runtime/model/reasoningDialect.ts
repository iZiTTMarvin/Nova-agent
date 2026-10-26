import type { ReasoningEffort } from '../../shared/config/types'
import {
  normalizeReasoningEffort,
  resolveReasoningCapability,
  resolveReasoningProtocol,
  resolveReasoningSelection
} from '../../shared/config/reasoning'

export type ReasoningEffortInput = ReasoningEffort | 'minimal'

/** 请求参数与路由身份共用归一结果；auto 不被服务商默认值替换。 */
export function resolveRequestReasoningEffort(
  modelId: string,
  configuredEffort: ReasoningEffort | undefined,
  overrideEffort?: ReasoningEffort,
  _baseUrl?: string
): ReasoningEffort {
  return resolveReasoningSelection({ modelId, reasoningEffort: configuredEffort }, overrideEffort)
}

export interface ReasoningParams {
  thinking?: { type: 'enabled' | 'disabled' | 'adaptive'; clear_thinking?: false }
  reasoning_effort?: string
}

/** 只翻译已登记的模型选择；未知模型保留服务商默认。 */
export function buildReasoningParams(
  modelId: string,
  baseUrl: string,
  effort: ReasoningEffortInput
): ReasoningParams | null {
  const capability = resolveReasoningCapability(modelId)
  const minimalEffort = capability?.kind === 'effort' && capability.protocol === 'thinking' ? 'low' : 'none'
  const selection = normalizeReasoningEffort(modelId, effort === 'minimal' ? minimalEffort : effort)
  const protocol = resolveReasoningProtocol(modelId, baseUrl)
  if (!capability || selection === undefined) return null
  if (capability.kind === 'unsupported' || capability.kind === 'fixed') return null
  if (selection === 'none') {
    return protocol !== 'effort' ? { thinking: { type: 'disabled' } } : { reasoning_effort: 'none' }
  }
  if (protocol === 'glm') {
    return {
      thinking: { type: 'enabled', clear_thinking: false },
      ...(selection !== 'auto' && selection !== 'enabled' ? { reasoning_effort: selection } : {})
    }
  }
  if (protocol === 'minimax') {
    if (selection === 'auto') return null
    return {
      thinking: { type: 'adaptive' },
      ...(capability.kind === 'effort' ? { reasoning_effort: selection } : {})
    }
  }
  if (selection === 'auto') return null
  if (selection === 'enabled') return { thinking: { type: 'enabled' } }
  return { reasoning_effort: selection }
}
