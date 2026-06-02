/**
 * Token 估算工具
 * 用 char/4 粗估 token 数，用于触发上下文压缩的阈值判断
 */

/** 粗略估算文本的 token 数（英文约 4 字符/token，中文约 2 字符/token，取折中值） */
export function estimateTokens(text: string): number {
  if (!text) return 0
  return Math.ceil(text.length / 4)
}

/** 估算一组消息的总 token 数 */
export function estimateContextTokens(messages: Array<{ content: string }>): number {
  let total = 0
  for (const msg of messages) {
    total += estimateTokens(msg.content)
  }
  return total
}
