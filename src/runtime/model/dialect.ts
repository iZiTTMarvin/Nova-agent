/**
 * 模型方言识别 —— 决定工具调用走原生通道还是 XML inband。
 *
 * 策略与 oh-my-pi 一致：
 * - 原生 tool_calls 已知稳定的模型家族：Anthropic Claude、OpenAI GPT/o 系列。
 * - 国产 / 类 OpenAI 中继（MiniMax、Kimi、GLM、DeepSeek、Qwen）通常对 OpenAI
 *   的 delta.tool_calls 支持参差不齐，统一走 XML inband 调用，由后端 scanner
 *   解析，行为更可预测。
 *
 * 模型识别基于 modelId（以及可选的 provider/baseUrl），大小写不敏感。
 */

/** 方言类型 */
export type ToolDialect = 'native' | 'xml'

/** 已知走原生 tool_calls 的家族前缀 / 关键字 */
const NATIVE_TOOL_FAMILIES: Record<string, true> = {
  claude: true,
  gpt: true,
  o1: true,
  o3: true,
  o4: true
}

/** 明确走 XML inband 的家族 / 关键字 */
const XML_TOOL_FAMILIES: Record<string, true> = {
  minimax: true,
  kimi: true,
  glm: true,
  qwen: true,
  deepseek: true,
  doubao: true,
  ernie: true
}

/**
 * 判断当前模型/provider 该用哪种工具调用方言。
 * @param modelId 模型标识，例如 "MiniMax-M3"、"claude-3-5-sonnet-20241022"
 * @param baseUrl 可选 API 地址，用于识别某些聚合平台（如 openrouter）上模型
 *                名义是 gpt/claude 但实际路由国产模型的情况。当前优先 modelId。
 */
export function preferredToolDialect(modelId: string, baseUrl?: string): ToolDialect {
  const tokens = modelId
    .toLowerCase()
    .replace(/[-_:./]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)

  // 1. 显式命中 XML 家族（优先，避免 openrouter 里 "openai/gpt-4" 被误判）
  for (const token of tokens) {
    if (XML_TOOL_FAMILIES[token]) return 'xml'
  }

  // 2. 显式命中原生家族
  for (const token of tokens) {
    if (NATIVE_TOOL_FAMILIES[token]) return 'native'
  }

  // 3. 按 baseUrl 兜底：anthropic / openai 原生端点走 native，其余走 xml
  const lowerUrl = (baseUrl ?? '').toLowerCase()
  if (lowerUrl.includes('anthropic') || lowerUrl.includes('openai.com')) {
    return 'native'
  }

  // 4. 未知模型默认走 XML，更保守；原生工具调用是“特权”而非默认。
  return 'xml'
}
