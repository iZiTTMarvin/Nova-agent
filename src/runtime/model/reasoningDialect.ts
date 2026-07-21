/**
 * 思考强度（reasoning effort）方言识别 —— 决定如何把 reasoningEffort 注入请求体。
 *
 * 各家 provider 对推理控制的字段不统一：
 * - OpenAI o 系列 / DeepSeek 官方 / GLM 新模型：统一支持 reasoning_effort（字符串）
 * - GLM（bigmodel.cn / z.ai）：除可选 reasoning_effort 外，需注入 thinking 对象开启保留式思考
 * - Anthropic 原生：用 thinking.budget_tokens（本项目走兼容端点，暂不覆盖）
 *
 * GLM 与 effort 解耦：'auto' 也注入 `thinking: { type: 'enabled', clear_thinking: false }`，
 * 仅在用户显式关闭（none / minimal）时不注入。其余端点仍为 'auto' 不注入。
 */
import type { ReasoningEffort } from '../../shared/config/llmRegistry'

/** GLM 系列端点域名片段（命中即按 GLM 方言注入） */
const GLM_HOSTS = ['bigmodel.cn', 'z.ai'] as const

/** 用户显式关闭思考时可传入；尚未进入 UI 枚举，函数侧先识别 */
export type ReasoningEffortInput = ReasoningEffort | 'none' | 'minimal'

/**
 * 根据 provider 方言构建思考强度请求参数。
 * @param modelId 模型标识（当前预留，便于未来按模型精细判定）
 * @param baseUrl API 地址，用于识别 GLM 端点
 * @param effort 思考强度；非 GLM 的 'auto' 返回 null；GLM 的 'auto' 仍注入保留式思考
 * @returns 注入到 chat/completions body 的参数对象，或 null（不注入）
 */
export function buildReasoningParams(
  modelId: string,
  baseUrl: string,
  effort: ReasoningEffortInput
): Record<string, unknown> | null {
  // 用户显式关闭思考
  if (effort === 'none' || effort === 'minimal') return null

  const lowerUrl = (baseUrl ?? '').toLowerCase()
  const isGlm = GLM_HOSTS.some(host => lowerUrl.includes(host))

  if (isGlm) {
    const params: Record<string, unknown> = {
      thinking: { type: 'enabled', clear_thinking: false }
    }
    if (effort && effort !== 'auto') {
      params.reasoning_effort = effort
    }
    return params
  }

  // 非 GLM：'auto' / 缺省不发送，让模型用默认行为
  if (!effort || effort === 'auto') return null

  return { reasoning_effort: effort }
}

/** 判断 baseUrl 是否为 GLM 官方/Coding Plan 端点 */
export function isGlmEndpoint(baseUrl: string): boolean {
  const lowerUrl = (baseUrl ?? '').toLowerCase()
  return GLM_HOSTS.some(host => lowerUrl.includes(host))
}
