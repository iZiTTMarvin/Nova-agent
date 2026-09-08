/**
 * Token 估算工具
 * 与请求预算复用文本估算；实际用量由供应商 usage 校准。
 */
import type { ChatMessage, ContentBlock } from '../model/types'
import { extractTextFromContent } from '../model/types'
import { estimateTextTokens } from '../../shared/model/tokenEstimate'

/** ASCII 文本的字符换算比。 */
export const CHARS_PER_TOKEN = 4

/** 粗略估算文本的 token 数 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  return estimateTextTokens(text)
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
