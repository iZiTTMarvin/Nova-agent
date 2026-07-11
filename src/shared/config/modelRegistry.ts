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
export interface ModelCapabilityEntry {
  /** 是否支持图片输入。true=明确支持；false=明确不支持 */
  supportsVision?: boolean
  /**
   * 上下文窗口（tokens）。
   * 可为官方规格，也可为 Nova 工程上限（须在注释标明）。
   * 未设时走 resolveContextWindow → inferContextWindow 兜底。
   */
  contextWindow?: number
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
  // contextWindow：官方有 1M 变体（如 glm-5.2[1m]），默认 API 窗口未单独核实，留空走兜底（2026-07）
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
  // 官方规格均为 1M（api-docs.deepseek.com/news/news260424，验证 2026-07）；
  // Nova 配置 500K 以控制 KV cache 成本与延迟，Agent 场景绰绰有余——这是工程上限，不是模型规格。
  'deepseek-v4-flash': {
    supportsVision: false,
    contextWindow: 500_000
  }, // 来源: Cherry Studio + litellm；官方 1M → Nova 500K（2026-07）
  'deepseek-v4-pro': {
    supportsVision: false,
    contextWindow: 500_000
  }, // 来源: Cherry Studio + litellm；官方 1M → Nova 500K（2026-07）
  // 旧名：官方已路由到 v4-flash；同样按 Nova 工程上限 500K
  'deepseek-chat': {
    supportsVision: false,
    contextWindow: 500_000
  }, // 官方 1M（同 V4）；Nova 500K（2026-07）
  'deepseek-reasoner': {
    supportsVision: false,
    contextWindow: 500_000
  }, // 官方 1M（同 V4）；Nova 500K（2026-07）

  // ── MiniMax（纠偏：模糊兜底把全部 minimax 判 true）──────
  // 官方上下文窗口 204,800（platform.minimax.io 文本生成文档，验证 2026-07）
  'minimax-m2.5': { supportsVision: false, contextWindow: 204_800 }, // 来源: Cherry + litellm；官方 204800（2026-07）
  'minimax-m2.5-highspeed': { supportsVision: false, contextWindow: 204_800 }, // 来源: Cherry；官方 204800（2026-07）
  'minimax-m3': { supportsVision: true }, // 来源: Cherry Studio + litellm；官方宣称 1M，未在本轮固化工程取值

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
