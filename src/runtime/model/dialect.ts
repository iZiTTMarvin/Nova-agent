/**
 * 模型方言识别 —— 决定工具调用走原生通道还是 XML inband。
 *
 * 策略（native 优先，inband 兜底）：
 * - 本项目对接各家官方云端 /chat/completions，服务端原生支持函数调用（DeepSeek DSML、
 *   Kimi/GLM/Qwen 等各家格式均由 API 解析为结构化 tool_calls）。
 * - 默认走 native：向 API 下发 tools，消费 delta.tool_calls。
 * - inband XML（XmlToolScanner）仅作兜底：用户显式 override='xml'，或命中确证 native
 *   不可用/不稳的端点（如 ollama 本地推理）时启用。MiniMax 官方端点与 DeepSeek/Kimi/GLM
 *   一致，走 native。
 *
 * 模型识别基于 modelId（以及可选的 baseUrl / 用户 override），大小写不敏感。
 */

/** 方言类型 */
export type ToolDialect = 'native' | 'xml'

/** 用户可在 LLM 配置中覆盖的方言选项；'auto' 走自动判定 */
export type ToolDialectOverride = ToolDialect | 'auto'

/** 已知走原生 tool_calls 的家族前缀 / 关键字 */
const NATIVE_TOOL_FAMILIES: Record<string, true> = {
  claude: true,
  gpt: true,
  o1: true,
  o3: true,
  o4: true
}

/**
 * 确证必须走 XML inband 的家族（native 不稳或不可用）。
 * 国产主流云端（含 MiniMax）已改走 native；仅保留本地推理等确证场景。
 */
const XML_FORCED_FAMILIES: Record<string, true> = {
  ollama: true
}

/**
 * 官方/主流 API 域名片段；baseUrl 命中即走 native。
 * 漏配只会少一次强制判定，兜底默认已是 native，不会重现 DSML 泄漏。
 */
const NATIVE_OFFICIAL_HOSTS = [
  'deepseek.com',
  'openai.com',
  'anthropic',
  'moonshot.cn',
  'moonshot.ai',
  'bigmodel.cn',
  'dashscope.aliyuncs.com',
  'dashscope.cn'
] as const

/**
 * 判断当前模型/provider 该用哪种工具调用方言。
 * @param modelId 模型标识，例如 "MiniMax-M3"、"claude-3-5-sonnet-20241022"
 * @param baseUrl 可选 API 地址，用于识别官方端点域名
 * @param override 用户显式覆盖（来自 ModelConfig.toolDialect）；'auto'/未传则自动判定
 */
export function preferredToolDialect(
  modelId: string,
  baseUrl?: string,
  override?: ToolDialectOverride
): ToolDialect {
  // 1. 显式覆盖优先级最高
  if (override === 'native' || override === 'xml') {
    return override
  }

  const tokens = modelId
    .toLowerCase()
    .replace(/[-_:./]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)

  const lowerUrl = (baseUrl ?? '').toLowerCase()

  // 2. 确证必须 inband 的家族
  for (const token of tokens) {
    if (XML_FORCED_FAMILIES[token]) return 'xml'
  }

  // 3. modelId 命中已知原生家族
  for (const token of tokens) {
    if (NATIVE_TOOL_FAMILIES[token]) return 'native'
  }

  // 4. 官方/主流端点域名
  if (NATIVE_OFFICIAL_HOSTS.some(host => lowerUrl.includes(host))) {
    return 'native'
  }

  // 5. 未知模型默认 native（官方云端绝大多数支持原生函数调用）
  return 'native'
}
