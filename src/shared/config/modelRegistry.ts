/**
 * 内置模型能力精确注册表（按 modelId 精确匹配，非模糊匹配）。
 *
 * 优先级链（见 resolveSupportsVision）：
 *   用户显式勾选(ModelConfig.supportsVision) > 本注册表精确匹配 > inferVisionSupport 字符串兜底 > 默认 false
 *
 * 数据来源：Cherry Studio 注册表 + litellm 模型表（见每条注释）。
 * 维护：新模型上线并确认能力后在此添加一条精确 modelId；拿不准的不收录。
 */
export interface ModelCapabilityEntry {
  /** 是否支持图片输入。true=明确支持；false=明确不支持 */
  supportsVision?: boolean
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
  'gpt-5.1': { supportsVision: true }, // 来源: litellm（Cherry 写作 gpt-5-1）
  'gpt-5.2': { supportsVision: true }, // 来源: litellm（Cherry 写作 gpt-5-2）
  'gpt-5.4': { supportsVision: true }, // 来源: litellm（Cherry 写作 gpt-5-4）
  'gpt-5.4-mini': { supportsVision: true }, // 来源: litellm（Cherry 写作 gpt-5-4-mini）
  'gpt-5.4-pro': { supportsVision: true }, // 来源: litellm（Cherry 写作 gpt-5-4-pro）
  'gpt-5.5': { supportsVision: true }, // 来源: litellm（Cherry 写作 gpt-5-5）
  'gpt-5.5-pro': { supportsVision: true }, // 来源: litellm（Cherry 写作 gpt-5-5-pro）
  o1: { supportsVision: true }, // 来源: Cherry Studio + litellm
  o3: { supportsVision: true }, // 来源: Cherry Studio + litellm
  'o3-mini': { supportsVision: false }, // 来源: litellm supports_vision=false
  'o4-mini': { supportsVision: true }, // 来源: Cherry Studio + litellm

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
  'glm-5': { supportsVision: false }, // 来源: Cherry Studio inputModalities=text
  'glm-5.1': { supportsVision: false }, // 来源: Cherry Studio（id: glm-5-1）inputModalities=text
  'glm-5-1': { supportsVision: false }, // 来源: Cherry Studio 连字符别名
  'glm-5.2': { supportsVision: false }, // 来源: Cherry Studio（id: glm-5-2）inputModalities=text
  'glm-5-2': { supportsVision: false }, // 来源: Cherry Studio 连字符别名
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
  'deepseek-v4-flash': { supportsVision: false }, // 来源: Cherry Studio + litellm
  'deepseek-v4-pro': { supportsVision: false }, // 来源: Cherry Studio + litellm

  // ── MiniMax（纠偏：模糊兜底把全部 minimax 判 true）──────
  'minimax-m2.5': { supportsVision: false }, // 来源: Cherry（minimax-m2-5）+ litellm openrouter=false
  'minimax-m2.5-highspeed': { supportsVision: false }, // 来源: Cherry Studio inputModalities=text
  'minimax-m3': { supportsVision: true }, // 来源: Cherry Studio + litellm

  // ── Moonshot Kimi ───────────────────────────────────────
  'kimi-k2': { supportsVision: false }, // 来源: Cherry Studio inputModalities=text
  'kimi-k2.5': { supportsVision: true }, // 来源: litellm（Cherry 写作 kimi-k2-5）
  'kimi-k2-5': { supportsVision: true }, // 来源: Cherry Studio 连字符别名
  'kimi-k2.6': { supportsVision: true }, // 来源: litellm（Cherry 写作 kimi-k2-6）
  'kimi-k2-6': { supportsVision: true }, // 来源: Cherry Studio 连字符别名
  // Cherry id 为 kimi-k2-7-code；litellm fireworks kimi-k2p7-code=true；API 常用点号写法
  'kimi-k2.7-code': { supportsVision: true }, // 来源: Cherry Studio（kimi-k2-7-code）+ litellm fireworks kimi-k2p7-code
  'kimi-k2-7-code': { supportsVision: true }, // 来源: Cherry Studio 连字符别名
  'kimi-latest': { supportsVision: true } // 来源: Cherry Studio + litellm
}

/** 查注册表。未命中返回 undefined。大小写不敏感。 */
export function lookupModelCapability(modelId: string): ModelCapabilityEntry | undefined {
  if (!modelId) return undefined
  return MODEL_CAPABILITY_REGISTRY[modelId.toLowerCase()]
}
