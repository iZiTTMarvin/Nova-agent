/**
 * Token 估算工具
 * 用 char/4 粗估 token 数，用于触发上下文压缩的阈值判断
 */
import type { ChatMessage, ContentBlock } from '../model/types'
import { extractTextFromContent } from '../model/types'

/** 粗略估算文本的 token 数（英文约 4 字符/token，中文约 2 字符/token，取折中值） */
export function estimateTokens(text: string): number {
  if (!text) return 0
  return Math.ceil(text.length / 4)
}

/** 估算一组消息的总 token 数 */
export function estimateContextTokens(messages: Array<{ content: string | ContentBlock[] }>): number {
  let total = 0
  for (const msg of messages) {
    total += estimateTokens(extractTextFromContent(msg.content))
  }
  return total
}

/** ChatMessage 单条 token 估算,正文 + tool_calls.arguments 都计入 */
export function estimateChatMessageTokens(msg: ChatMessage): number {
  let total = estimateTokens(extractTextFromContent(msg.content))
  if (msg.toolCalls) {
    for (const tc of msg.toolCalls) {
      total += estimateTokens(tc.arguments)
    }
  }
  return total
}
