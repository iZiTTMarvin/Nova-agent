/**
 * 内置模型能力精确注册表（按 modelId 精确匹配，非模糊匹配）。
 *
 * 优先级链：
 *   supportsVision → resolveSupportsVision
 *   contextWindow  → resolveContextWindow
 *   用户显式配置 > 本注册表精确匹配 > 字符串兜底推断 > 保守默认
 *
 * 数据来源：Cherry Studio 注册表 + litellm 模型表 + 各厂商官方文档（见每条注释）。
 * 维护：新模型上线并确认能力后在此添加一条精确 modelId；拿不准的不收录。
 */
import type { ReasoningEffort } from './types'
import type { ReasoningCapability } from './reasoning'

export interface ModelCapabilityEntry {
  /** 是否支持图片输入。true=明确支持；false=明确不支持 */
  supportsVision?: boolean
  /**
   * 上下文窗口（tokens）。
   * 可为官方规格，也可为 Nova 工程上限（须在注释标明）。
   * 未设时走 resolveContextWindow → inferContextWindow 兜底。
   */
  contextWindow?: number
  reasoning?: ReasoningCapability
}

const VERIFIED_AT = '2026-10-26'
const OPENAI_SOURCE = 'https://platform.openai.com/docs/guides/reasoning'
const GLM_SOURCE = 'https://docs.bigmodel.cn/cn/guide/capabilities/thinking'
const MINIMAX_SOURCE = 'https://platform.minimax.io/docs/api-reference/text-openai-api'
const DEEPSEEK_SOURCE = 'https://api-docs.deepseek.com/guides/thinking_mode'

function effortCapability(
  levels: readonly Exclude<ReasoningEffort, 'auto' | 'none' | 'enabled'>[],
  defaultEffort: Exclude<ReasoningEffort, 'auto' | 'enabled'>,
  source = OPENAI_SOURCE,
  canDisable = false
): ReasoningCapability {
  return { kind: 'effort', protocol: 'effort', levels, default: defaultEffort, canDisable, source, verifiedAt: VERIFIED_AT }
}

const GLM_52_REASONING: ReasoningCapability = {
  kind: 'effort', protocol: 'glm', levels: ['high', 'max'], default: 'max', canDisable: true,
  aliases: { low: 'high', medium: 'high', xhigh: 'max' }, source: GLM_SOURCE, verifiedAt: VERIFIED_AT
}
const GLM_53_REASONING: ReasoningCapability = {
  kind: 'effort', protocol: 'glm', levels: ['low', 'high', 'max'], default: 'max',
  source: GLM_SOURCE, verifiedAt: VERIFIED_AT
}
const GLM_TOGGLE: ReasoningCapability = {
  kind: 'toggle', protocol: 'glm', default: 'enabled', source: GLM_SOURCE, verifiedAt: VERIFIED_AT
}
const MINIMAX_FIXED: ReasoningCapability = {
  kind: 'fixed', protocol: 'minimax', source: MINIMAX_SOURCE, verifiedAt: VERIFIED_AT
}
const MINIMAX_TOGGLE: ReasoningCapability = {
  kind: 'toggle', protocol: 'minimax', default: 'enabled', source: MINIMAX_SOURCE, verifiedAt: VERIFIED_AT
}
const DEEPSEEK_REASONING: ReasoningCapability = {
  kind: 'effort', protocol: 'thinking', levels: ['low', 'high', 'max'], default: 'high', canDisable: true,
  source: DEEPSEEK_SOURCE, verifiedAt: VERIFIED_AT
}
const KIMI_SOURCE = 'https://platform.kimi.ai/docs/api/models-overview.md'
const KIMI_REASONING: ReasoningCapability = {
  kind: 'effort', protocol: 'effort', levels: ['low', 'high', 'max'], default: 'max',
  source: KIMI_SOURCE, verifiedAt: VERIFIED_AT
}
const KIMI_TOGGLE: ReasoningCapability = {
  kind: 'toggle', protocol: 'thinking', default: 'enabled', source: KIMI_SOURCE, verifiedAt: VERIFIED_AT
}
const KIMI_FIXED: ReasoningCapability = {
  kind: 'fixed', protocol: 'thinking', source: KIMI_SOURCE, verifiedAt: VERIFIED_AT
}

/** 精确 modelId → 能力。查找时统一 toLowerCase 全等匹配。 */
export const MODEL_CAPABILITY_REGISTRY: Record<string, ModelCapabilityEntry> = {
  // ── OpenAI ──────────────────────────────────────────────
  'gpt-4o': { supportsVision: true }, // 来源: Cherry Studio + litellm
  'gpt-4o-mini': { supportsVision: true }, // 来源: Cherry Studio + litellm
  'gpt-4.1': { supportsVision: true }, // 来源: litellm（Cherry 写作 gpt-4-1）
  'gpt-4.1-mini': { supportsVision: true }, // 来源: litellm（Cherry 写作 gpt-4-1-mini）
  'gpt-4-turbo': { supportsVision: true }, // 来源: Cherry Studio + litellm
  'gpt-5': { supportsVision: true }, // 来源: Cherry Studio + litellm
  'gpt-5-mini': { supportsVision: true }, // 来源: Cherry Studio + litellm
  'gpt-5.1': { supportsVision: true, reasoning: effortCapability(['low', 'medium', 'high'], 'none', 'https://developers.openai.com/api/docs/models/gpt-5.1', true) },
  'gpt-5.2': { supportsVision: true, reasoning: effortCapability(['low', 'medium', 'high', 'xhigh'], 'none', 'https://developers.openai.com/api/docs/models/gpt-5.2', true) },
  'gpt-5.4': { supportsVision: true, reasoning: effortCapability(['low', 'medium', 'high', 'xhigh'], 'none', 'https://developers.openai.com/api/docs/models/gpt-5.4', true) },
  'gpt-5.4-mini': { supportsVision: true }, // 来源: litellm（Cherry 写作 gpt-5-4-mini）
  'gpt-5.4-pro': { supportsVision: true }, // 来源: litellm（Cherry 写作 gpt-5-4-pro）
  'gpt-5.5': { supportsVision: true, reasoning: effortCapability(['low', 'medium', 'high', 'xhigh'], 'medium', 'https://developers.openai.com/api/docs/models/gpt-5.5', true) },
  'gpt-5.5-pro': { supportsVision: true }, // 来源: litellm（Cherry 写作 gpt-5-5-pro）
  'gpt-5.6-sol': { supportsVision: true, reasoning: effortCapability(['low', 'medium', 'high', 'xhigh', 'max'], 'medium', OPENAI_SOURCE, true) },
  'gpt-5.6-terra': { supportsVision: true, reasoning: effortCapability(['low', 'medium', 'high', 'xhigh', 'max'], 'medium', OPENAI_SOURCE, true) },
  'gpt-5.6-luna': { supportsVision: true, reasoning: effortCapability(['low', 'medium', 'high', 'xhigh', 'max'], 'medium', OPENAI_SOURCE, true) },
  'gpt-6-astra': { supportsVision: true, reasoning: effortCapability(['low', 'medium', 'high', 'xhigh', 'max'], 'low') },
  'gpt-6.1-sol': { reasoning: effortCapability(['low', 'medium', 'high', 'xhigh', 'max'], 'medium') },
  o1: { supportsVision: true, reasoning: effortCapability(['low', 'medium', 'high'], 'medium') },
  o3: { supportsVision: true, reasoning: effortCapability(['low', 'medium', 'high'], 'medium') },
  'o3-mini': { supportsVision: false, reasoning: effortCapability(['low', 'medium', 'high'], 'medium') },
  'o4-mini': { supportsVision: true, reasoning: effortCapability(['low', 'medium', 'high'], 'medium') },

  // ── Anthropic ───────────────────────────────────────────
  'claude-sonnet-4': { supportsVision: true }, // 来源: Cherry Studio + litellm
  'claude-sonnet-4-5': { supportsVision: true }, // 来源: Cherry Studio + litellm
  'claude-sonnet-4-6': { supportsVision: true }, // 来源: Cherry Studio + litellm
  'claude-sonnet-5': { supportsVision: true }, // 来源: Cherry Studio + litellm
  'claude-opus-4': { supportsVision: true }, // 来源: Cherry Studio + litellm
  'claude-opus-4-5': { supportsVision: true }, // 来源: Cherry Studio + litellm
  'claude-opus-4-6': { supportsVision: true }, // 来源: Cherry Studio + litellm
  'claude-opus-4-7': { supportsVision: true }, // 来源: Cherry Studio + litellm
  'claude-opus-4-8': { supportsVision: true }, // 来源: Cherry Studio + litellm
  'claude-haiku-4-5': { supportsVision: true }, // 来源: Cherry Studio + litellm
  'claude-3-7-sonnet-20250219': { supportsVision: true }, // 来源: litellm

  // ── Google Gemini ───────────────────────────────────────
  'gemini-2.0-flash': { supportsVision: true }, // 来源: litellm（Cherry 写作 gemini-2-0-flash）
  'gemini-2.5-flash': { supportsVision: true }, // 来源: litellm（Cherry 写作 gemini-2-5-flash）
  'gemini-2.5-pro': { supportsVision: true }, // 来源: litellm（Cherry 写作 gemini-2-5-pro）
  'gemini-3-flash-preview': { supportsVision: true }, // 来源: Cherry Studio + litellm
  'gemini-3-pro-preview': { supportsVision: true }, // 来源: Cherry Studio + litellm
  'gemini-3.1-pro-preview': { supportsVision: true }, // 来源: litellm（Cherry 写作 gemini-3-1-pro-preview）
  'gemini-3.1-flash-lite': { supportsVision: true }, // 来源: litellm（Cherry 写作 gemini-3-1-flash-lite）
  'gemini-3.5-flash': { supportsVision: true }, // 来源: litellm（Cherry 写作 gemini-3-5-flash）

  // ── 智谱 GLM ────────────────────────────────────────────
  // 纯文本主型号（纠偏：模糊兜底无法识别 glm-5.x）
  // contextWindow：官方有 1M 变体（如 glm-5.2[1m]），默认 API 窗口未单独核实，留空走兜底（2026-07）
  'glm-5': { supportsVision: false, reasoning: GLM_TOGGLE },
  'glm-5.1': { supportsVision: false, reasoning: GLM_TOGGLE },
  'glm-5-1': { supportsVision: false, reasoning: GLM_TOGGLE },
  'glm-5.2': { supportsVision: false, reasoning: GLM_52_REASONING },
  'glm-5-2': { supportsVision: false, reasoning: GLM_52_REASONING },
  'glm-5.3': { supportsVision: false, reasoning: GLM_53_REASONING },
  'glm-5-3': { supportsVision: false, reasoning: GLM_53_REASONING },
  'glm-5.3-flash': { supportsVision: true, reasoning: GLM_53_REASONING },
  'glm-5-3-flash': { supportsVision: true, reasoning: GLM_53_REASONING },
  'glm-4.6': { reasoning: GLM_TOGGLE },
  // 视觉变体
  'glm-4v': { supportsVision: true }, // 来源: Cherry Studio
  'glm-4v-flash': { supportsVision: true }, // 来源: Cherry Studio
  'glm-4v-plus': { supportsVision: true }, // 来源: Cherry Studio
  'glm-4.5v': { supportsVision: true }, // 来源: litellm（Cherry 写作 glm-4-5v）
  'glm-4-5v': { supportsVision: true }, // 来源: Cherry Studio 连字符别名
  'glm-4.6v': { supportsVision: true }, // 来源: litellm（Cherry 写作 glm-4-6v）
  'glm-4-6v': { supportsVision: true }, // 来源: Cherry Studio 连字符别名
  'glm-5v-turbo': { supportsVision: true }, // 来源: Cherry Studio inputModalities 含 image

  // ── 通义 Qwen ───────────────────────────────────────────
  'qwen-vl-plus': { supportsVision: true }, // 来源: litellm
  'qwen2.5-vl-72b-instruct': { supportsVision: true }, // 来源: litellm
  'qwen3-vl-plus': { supportsVision: true }, // 来源: Cherry Studio + litellm
  'qwen3.5-plus': { supportsVision: true }, // 来源: litellm（Cherry 写作 qwen3-5-plus）
  'qwen3.6-plus': { supportsVision: true }, // 来源: litellm（Cherry 写作 qwen3-6-plus）

  // ── 小米 MiMo（纠偏：模糊兜底把全部 mimo 判 true）────────
  'mimo-v2.5': { supportsVision: true }, // 来源: litellm（Cherry 写作 mimo-v2-5）
  'mimo-v2-5': { supportsVision: true }, // 来源: Cherry Studio 连字符别名
  'mimo-v2.5-pro': { supportsVision: false }, // 来源: litellm supports_vision=false
  'mimo-v2-5-pro': { supportsVision: false }, // 来源: Cherry Studio inputModalities=text
  'mimo-v2-flash': { supportsVision: false }, // 来源: Cherry Studio + litellm

  // ── DeepSeek ────────────────────────────────────────────
  // 官方规格均为 1M（api-docs.deepseek.com/news/news260424，验证 2026-07）；
  // Nova 配置 500K 以控制 KV cache 成本与延迟，Agent 场景绰绰有余——这是工程上限，不是模型规格。
  'deepseek-v4-flash': {
    supportsVision: false,
    contextWindow: 500_000,
    reasoning: DEEPSEEK_REASONING
  }, // 来源: Cherry Studio + litellm；官方 1M → Nova 500K（2026-07）；档位见官方 thinking_mode 文档
  'deepseek-v4-pro': {
    supportsVision: false,
    contextWindow: 500_000,
    reasoning: DEEPSEEK_REASONING
  }, // 来源: Cherry Studio + litellm；官方 1M → Nova 500K（2026-07）；档位见官方 thinking_mode 文档
  // 旧名：官方已路由到 v4-flash；同样按 Nova 工程上限 500K
  'deepseek-chat': {
    supportsVision: false,
    contextWindow: 500_000,
    reasoning: DEEPSEEK_REASONING
  }, // 官方 1M（同 V4）；Nova 500K（2026-07）；档位见官方 thinking_mode 文档
  'deepseek-reasoner': {
    supportsVision: false,
    contextWindow: 500_000,
    reasoning: DEEPSEEK_REASONING
  }, // 官方 1M（同 V4）；Nova 500K（2026-07）；档位见官方 thinking_mode 文档

  // ── MiniMax（纠偏：模糊兜底把全部 minimax 判 true）──────
  // 官方上下文窗口 204,800（platform.minimax.io 文本生成文档，验证 2026-07）；
  'minimax-m2': { supportsVision: false, contextWindow: 204_800, reasoning: MINIMAX_FIXED },
  'minimax-m2.1': { supportsVision: false, contextWindow: 204_800, reasoning: MINIMAX_FIXED },
  'minimax-m2.5': { supportsVision: false, contextWindow: 204_800, reasoning: MINIMAX_FIXED },
  'minimax-m2.5-highspeed': { supportsVision: false, contextWindow: 204_800, reasoning: MINIMAX_FIXED },
  'minimax-m2.6': { supportsVision: false, contextWindow: 204_800, reasoning: MINIMAX_FIXED },
  'minimax-m2.6-highspeed': { supportsVision: false, contextWindow: 204_800, reasoning: MINIMAX_FIXED },
  'minimax-m2.7': { supportsVision: false, contextWindow: 204_800, reasoning: MINIMAX_FIXED },
  'minimax-m2-7': { supportsVision: false, contextWindow: 204_800, reasoning: MINIMAX_FIXED },
  'minimax-m2.7-highspeed': { supportsVision: false, contextWindow: 204_800, reasoning: MINIMAX_FIXED },
  'minimax-m2-7-highspeed': { supportsVision: false, contextWindow: 204_800, reasoning: MINIMAX_FIXED },
  'minimax-m3': { supportsVision: true, reasoning: MINIMAX_TOGGLE },
  'minimax-m3.1-flash': { reasoning: { kind: 'effort', protocol: 'minimax', levels: ['low', 'medium', 'high', 'xhigh', 'max'], default: 'max', source: MINIMAX_SOURCE, verifiedAt: VERIFIED_AT } },

  // ── Moonshot Kimi ───────────────────────────────────────
  'kimi-k2': { supportsVision: false }, // 来源: Cherry Studio inputModalities=text
  'kimi-k2.5': { supportsVision: true }, // 来源: litellm（Cherry 写作 kimi-k2-5）
  'kimi-k2-5': { supportsVision: true }, // 来源: Cherry Studio 连字符别名
  'kimi-k2.6': { supportsVision: true, reasoning: KIMI_TOGGLE },
  'kimi-k2-6': { supportsVision: true, reasoning: KIMI_TOGGLE },
  // Cherry id 为 kimi-k2-7-code；litellm fireworks kimi-k2p7-code=true；API 常用点号写法
  'kimi-k2.7-code': { supportsVision: true, reasoning: KIMI_FIXED },
  'kimi-k2-7-code': { supportsVision: true, reasoning: KIMI_FIXED },
  'kimi-k2.7-code-highspeed': { reasoning: KIMI_FIXED },
  'kimi-k3': { reasoning: KIMI_REASONING },
  'kimi-k3.1-pro': { reasoning: KIMI_REASONING },
  'kimi-k3.1-pro-highspeed': { reasoning: KIMI_REASONING },
  'kimi-latest': { supportsVision: true } // 来源: Cherry Studio + litellm
}

/** 精确查找，允许网关前缀；未知点版本不继承其他型号的能力。 */
export function lookupModelCapability(modelId: string): ModelCapabilityEntry | undefined {
  if (!modelId) return undefined
  const lower = modelId.trim().toLowerCase()
  if (!lower) return undefined
  const direct = MODEL_CAPABILITY_REGISTRY[lower]
  if (direct) return direct

  const bare = lower.includes('/') ? lower.slice(lower.lastIndexOf('/') + 1) : lower
  const byBare = MODEL_CAPABILITY_REGISTRY[bare]
  if (byBare) return byBare

  return undefined
}
