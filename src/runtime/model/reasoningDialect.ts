/**
 * 思考强度（reasoning effort）方言识别 —— 决定如何把 reasoningEffort 注入请求体。
 *
 * 各家 provider 对推理控制的字段不统一：
 * - OpenAI o 系列 / DeepSeek 官方 / GLM 新模型：统一支持 reasoning_effort（字符串）
 * - GLM（bigmodel.cn / z.ai）：除 reasoning_effort 外，老接口需额外带 thinking 对象兜底
 * - Anthropic 原生：用 thinking.budget_tokens（本项目走兼容端点，暂不覆盖）
 *
 * 策略：'auto'（默认）一律不注入，保持现状；其余按 baseUrl 域名片段判定 provider 方言。
 */
import type { ReasoningEffort } from '../../shared/config/llmRegistry'

/** GLM 系列端点域名片段（命中即按 GLM 方言注入） */
const GLM_HOSTS = ['bigmodel.cn', 'z.ai'] as const

/**
 * 根据 provider 方言构建思考强度请求参数。
 * @param modelId 模型标识（当前预留，便于未来按模型精细判定）
 * @param baseUrl API 地址，用于识别 GLM 端点
 * @param effort 思考强度；'auto' 返回 null（不注入）
 * @returns 注入到 chat/completions body 的参数对象，或 null（不注入）
 */
export function buildReasoningParams(
  modelId: string,
  baseUrl: string,
  effort: ReasoningEffort
): Record<string, unknown> | null {
  // 'auto' / 缺省：不发送该参数，让模型用默认行为
  if (!effort || effort === 'auto') return null

  const lowerUrl = (baseUrl ?? '').toLowerCase()

  // GLM：reasoning_effort + thinking 对象兜底（兼容 coding 端点与老接口）
  if (GLM_HOSTS.some(host => lowerUrl.includes(host))) {
    return {
      thinking: { type: 'enabled' },
      reasoning_effort: effort
    }
  }

  // 其余 OpenAI 兼容端点（DeepSeek 官方 / OpenAI o 系列等）：纯 reasoning_effort
  return { reasoning_effort: effort }
}
