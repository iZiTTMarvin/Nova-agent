/**
 * 上下文溢出检测模块
 * 参考 OpenClacky context_too_long_error? 设计
 */

const STRONG_PHRASES = [
  'context length',
  'context_length_exceeded',
  'maximum context',
  'maximum input length',
  'prompt is too long',
  'input is too long',
  'exceeds the maximum context',
  "exceeds the model's context",
  "exceeds the model's maximum",
  'reduce the length of the input',
  'reduce the length of the messages',
  'reduce the length of your',
  'reduce the length of the prompt',
  'range of input length',
]

/**
 * 判断 API 响应错误是否为上下文超限（Context Overflow）
 *
 * 采用宽松检测匹配策略（容忍 false positive 以规避 Agent 卡死崩溃）：
 * - 只对 HTTP 400 状态码进行错误消息匹配
 * - 对 OpenAI、Anthropic、Qwen (DashScope) 以及 DeepSeek 等通用 Provider 的报错模式进行全面覆盖
 *
 * @param statusCode HTTP 状态码
 * @param errorBody API 返回的错误响应体内容
 * @returns 是否属于上下文溢出错误
 */
export function isContextOverflowError(statusCode: number, errorBody: string): boolean {
  if (statusCode !== 400) return false
  const msg = errorBody.toLowerCase()

  // 1. 匹配常见的强短语模式
  if (STRONG_PHRASES.some(p => msg.includes(p))) return true

  // 2. 匹配 Anthropic 报错模式: "<N> tokens > <N> maximum"
  // 注意：此处偏离 TODO 规格的 \s*，改用 [\s\S]* 宽松匹配以容纳 Anthropic 实际报错信息（例如 tokens 后面带有 ", which is " 等连接字符）
  if (/\d+\s*tokens?[\s\S]*>\s*\d+/.test(msg)) return true

  // 3. 匹配阿里千问结构化错误: "parameter=input_tokens"
  if (msg.includes('parameter=input_tokens')) return true

  return false
}
