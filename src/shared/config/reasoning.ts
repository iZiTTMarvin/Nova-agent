import type { ReasoningEffort } from './types'
import { lookupModelCapability } from './modelRegistry'

export type ReasoningLevel = Exclude<ReasoningEffort, 'auto' | 'enabled' | 'none'>
export type ReasoningProtocol = 'effort' | 'thinking' | 'glm' | 'minimax'

interface ReasoningEvidence {
  readonly source: string
  readonly verifiedAt: string
}

export type ReasoningCapability = ReasoningEvidence & (
  | { readonly kind: 'fixed'; readonly protocol: ReasoningProtocol }
  | { readonly kind: 'toggle'; readonly protocol: ReasoningProtocol; readonly default: 'enabled' | 'none' }
  | {
      readonly kind: 'effort'
      readonly protocol: ReasoningProtocol
      readonly levels: readonly ReasoningLevel[]
      readonly default?: ReasoningLevel | 'none'
      readonly canDisable?: boolean
      readonly aliases?: Readonly<Partial<Record<ReasoningEffort, ReasoningEffort>>>
    }
  | { readonly kind: 'unsupported' }
)

export interface ReasoningModel {
  readonly modelId: string
  readonly reasoningEffort?: ReasoningEffort
}

export const REASONING_LABELS: Readonly<Record<ReasoningEffort, string>> = {
  auto: '服务商默认', enabled: '开启', none: '关闭',
  low: 'Low', medium: 'Medium', high: 'High', xhigh: 'XHigh', max: 'Max'
}

/** 只解析已登记事实；未知型号不从家族名推断思考档位。 */
export function resolveReasoningCapability(modelId: string): ReasoningCapability | undefined {
  return lookupModelCapability(modelId)?.reasoning
}

export function getReasoningChoices(modelId: string): readonly ReasoningEffort[] | null {
  const capability = resolveReasoningCapability(modelId)
  if (!capability) return null
  if (capability.kind === 'effort') {
    return ['auto', ...(capability.canDisable ? ['none' as const] : []), ...capability.levels]
  }
  return capability.kind === 'toggle' ? ['auto', 'none', 'enabled'] : ['auto']
}

/** GLM 参数别名和已发布 MiniMax 虚拟档位仅在这里收敛，UI 不展示别名。 */
export function normalizeReasoningEffort(modelId: string, effort: ReasoningEffort): ReasoningEffort | undefined {
  if (effort === 'auto') return effort
  const capability = resolveReasoningCapability(modelId)
  if (!capability) return undefined
  if (capability.kind === 'fixed' && capability.protocol === 'minimax') return effort === 'high' || effort === 'max' ? 'auto' : undefined
  if (capability.kind === 'toggle' && capability.protocol === 'minimax' && (effort === 'high' || effort === 'max')) return 'enabled'
  const normalized = capability.kind === 'effort' ? capability.aliases?.[effort] ?? effort : effort
  return getReasoningChoices(modelId)?.includes(normalized) ? normalized : undefined
}

export function resolveReasoningSelection(
  model: ReasoningModel,
  override?: ReasoningEffort
): ReasoningEffort {
  const configured = normalizeReasoningEffort(model.modelId, model.reasoningEffort ?? 'auto') ?? 'auto'
  return override === undefined ? configured : normalizeReasoningEffort(model.modelId, override) ?? configured
}

export function getReasoningDefault(modelId: string): ReasoningEffort | undefined {
  const capability = resolveReasoningCapability(modelId)
  return capability?.kind === 'effort' || capability?.kind === 'toggle' ? capability.default : undefined
}

export function reasoningSelectionLabel(modelId: string, selection: ReasoningEffort): string {
  if (selection === 'auto' && resolveReasoningCapability(modelId)?.kind === 'fixed') return '固定思考'
  const knownDefault = getReasoningDefault(modelId)
  return selection === 'auto' && knownDefault
    ? `默认 · ${REASONING_LABELS[knownDefault]}`
    : REASONING_LABELS[selection]
}

/** 官方端点与已登记型号共同决定编码，未知型号不推断私有字段。 */
export function resolveReasoningProtocol(modelId: string, baseUrl: string): ReasoningProtocol {
  let host = ''
  try { host = new URL(baseUrl).hostname.toLowerCase() } catch { /* 临时配置可能没有端点 */ }
  const matches = (domain: string): boolean => host === domain || host.endsWith(`.${domain}`)
  const capability = resolveReasoningCapability(modelId)
  if (!capability || capability.kind === 'unsupported') return 'effort'
  if ((matches('bigmodel.cn') || matches('z.ai')) && capability.protocol === 'glm') return 'glm'
  if ((matches('minimax.chat') || matches('minimax.io') || matches('minimaxi.com')) && capability.protocol === 'minimax') return 'minimax'
  if ((matches('deepseek.com') || matches('moonshot.ai') || matches('moonshot.cn')) && capability.protocol === 'thinking') return 'thinking'
  // 已登记型号沿用其公开协议；未知型号在上方返回，不能从名称猜字段。
  return capability.protocol
}
