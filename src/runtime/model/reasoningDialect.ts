/**
 * 思考强度（reasoning effort）方言识别 —— 决定如何把 reasoningEffort 注入请求体。
 *
 * 各家 provider 对推理控制的字段不统一：
 * - OpenAI o 系列 / DeepSeek 官方：reasoning_effort（字符串）
 * - GLM（bigmodel.cn / z.ai）：thinking.type=enabled + 可选 reasoning_effort
 * - MiniMax 官方：thinking.type=adaptive；High/Max 仅为产品侧档位，不发送未文档化 effort
 * - Anthropic 原生：thinking.budget_tokens（本项目走兼容端点，暂不覆盖）
 *
 * GLM 的 'auto' 仍注入保留式思考；MiniMax / 其余端点的 'auto' 不注入，沿用服务商默认。
 */
import type { ReasoningEffort } from '../../shared/config/types'
import { lookupModelCapability } from '../../shared/config/modelRegistry'

/** GLM 系列端点域名片段（命中即按 GLM 方言注入） */
const GLM_HOSTS = ['bigmodel.cn', 'z.ai'] as const
/** MiniMax 官方端点；与 cacheProfile 的 host 识别对齐 */
const MINIMAX_HOSTS = ['minimax.chat', 'minimax.io', 'minimaxi.com'] as const

/** 用户显式关闭思考时可传入；尚未进入 UI 枚举，函数侧先识别 */
export type ReasoningEffortInput = ReasoningEffort | 'none' | 'minimal'

/** 判断 baseUrl 是否为 GLM 官方/Coding Plan 端点 */
export function isGlmEndpoint(baseUrl: string): boolean {
  const lowerUrl = (baseUrl ?? '').toLowerCase()
  return GLM_HOSTS.some(host => lowerUrl.includes(host))
}

/** 判断 baseUrl 是否为 MiniMax 官方端点 */
export function isMinimaxEndpoint(baseUrl: string): boolean {
  const lowerUrl = (baseUrl ?? '').toLowerCase()
  return MINIMAX_HOSTS.some(host => lowerUrl.includes(host))
}

/** 已登记能力且当前值不在集合内时，才认为是无效强度；未知能力不误伤。 */
function hasUnsupportedKnownEffort(modelId: string, effort: ReasoningEffort): boolean {
  const supportedEfforts = lookupModelCapability(modelId)?.reasoningEfforts
  return effort !== 'auto' && supportedEfforts !== undefined && !supportedEfforts.includes(effort)
}

/**
 * 解析一次请求实际使用的强度：请求级覆盖只在当前模型支持时生效，
 * 否则回落到已归一的模型默认值，避免旧配置把默认高档误降成 auto。
 */
export function resolveRequestReasoningEffort(
  modelId: string,
  configuredEffort: ReasoningEffort | undefined,
  overrideEffort?: ReasoningEffort,
  baseUrl?: string
): ReasoningEffort {
  const fallback = configuredEffort && !hasUnsupportedKnownEffort(modelId, configuredEffort)
    ? configuredEffort
    : 'auto'
  const requested = overrideEffort === undefined || hasUnsupportedKnownEffort(modelId, overrideEffort)
    ? fallback
    : overrideEffort
  // MiniMax 官方兼容端点把所有启用档统一为 adaptive；用 high 作为 wire 身份，
  // 既保留启用语义，也避免 High/Max 制造无意义的缓存分叉。
  return baseUrl && isMinimaxEndpoint(baseUrl) && requested !== 'auto' ? 'high' : requested
}

/**
 * 根据 provider 方言构建思考强度请求参数。
 * @param modelId 模型标识，用于读取能力注册表中的可选强度
 * @param baseUrl API 地址，用于识别 GLM / MiniMax 端点
 * @param effort 思考强度；非 GLM 的 'auto' 返回 null；GLM 的 'auto' 仍注入保留式思考
 * @returns 注入到 chat/completions body 的参数对象，或 null（不注入）
 */
export function buildReasoningParams(
  modelId: string,
  baseUrl: string,
  effort: ReasoningEffortInput
): Record<string, unknown> | null {
  if (effort === 'none' || effort === 'minimal') {
    // MiniMax-M3 默认开思考；显式关闭必须发 disabled，省略等于仍开启。
    return isMinimaxEndpoint(baseUrl) ? { thinking: { type: 'disabled' } } : null
  }

  if (hasUnsupportedKnownEffort(modelId, effort)) return null

  if (isGlmEndpoint(baseUrl)) {
    const params: Record<string, unknown> = {
      thinking: { type: 'enabled', clear_thinking: false }
    }
    if (effort !== 'auto') {
      params.reasoning_effort = effort
    }
    return params
  }

  if (isMinimaxEndpoint(baseUrl)) {
    if (effort === 'auto') return null
    // 官方只提供 thinking 开关（adaptive/disabled），reasoning_effort 未在文档列出：
    // 档位在 UI 侧表达，wire 上不发送未文档化参数，避免被网关拒绝。
    return { thinking: { type: 'adaptive' } }
  }

  // 其余端点：'auto' / 缺省不发送，让模型用默认行为
  if (effort === 'auto') return null

  return { reasoning_effort: effort }
}
