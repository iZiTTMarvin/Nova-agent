/**
 * toolResultAging — 旧工具结果单行占位老化
 *
 * 将 assistant(toolCalls) + tool 消息划分为工具组；仅处理 MIN_RECENT_MESSAGES
 * 保护区之外的组。组年龄 = 组起始前 user 消息数；年龄 > 8 且（组内字节 > 8KB
 * 或任一带 artifactId）时，将该组 tool 消息替换为单行占位，保留 toolCallId 配对。
 */
import type { ChatMessage, ContentBlock } from '../model/types'
import { extractTextFromContent } from '../model/types'
import { MIN_RECENT_MESSAGES, alignToToolGroupBoundary } from './compaction'

/** 组年龄阈值：起始位置之前超过该 user 回合数才老化 */
export const AGING_USER_TURN_THRESHOLD = 8
/** 组内 tool 文本字节阈值（8KB） */
export const AGING_GROUP_BYTES_THRESHOLD = 8 * 1024

/**
 * 预计算 user 消息前缀和：userPrefix[i] = messages[0..i) 中 user 条数。
 * 查询 index 前 user 数：userPrefix[index]（O(1)）。
 */
function buildUserTurnPrefix(messages: ChatMessage[]): number[] {
  const prefix = new Array<number>(messages.length + 1).fill(0)
  for (let i = 0; i < messages.length; i++) {
    prefix[i + 1] = prefix[i] + (messages[i].role === 'user' ? 1 : 0)
  }
  return prefix
}

/** 组内 tool 消息文本总字节数 */
function sumToolGroupBytes(toolMessages: ChatMessage[]): number {
  return toolMessages.reduce(
    (sum, m) => sum + Buffer.byteLength(extractTextFromContent(m.content), 'utf8'),
    0
  )
}

/** 构建老化占位单行 */
function buildAgedPlaceholder(
  toolName: string,
  artifactId: string | undefined,
  content: string | ContentBlock[]
): string {
  const firstLine = extractTextFromContent(content).split('\n')[0]?.slice(0, 200) ?? ''
  const artifactPart = artifactId ? `(artifact://${artifactId})` : ''
  return `[aged tool result] ${toolName}${artifactPart}: ${firstLine}`
}

/**
 * 对上下文中的旧工具组执行老化，返回新上下文（不 mutate 原数组）。
 * system 消息原样保留；recent MIN_RECENT_MESSAGES 区域内的工具组不处理。
 */
export function ageToolResults(context: ChatMessage[]): ChatMessage[] {
  const nonSystemIndices: number[] = []
  const nonSystem: ChatMessage[] = []
  for (let i = 0; i < context.length; i++) {
    if (context[i].role !== 'system') {
      nonSystemIndices.push(i)
      nonSystem.push(context[i])
    }
  }

  if (nonSystem.length <= MIN_RECENT_MESSAGES) {
    return context
  }

  let splitIndex = nonSystem.length - MIN_RECENT_MESSAGES
  splitIndex = alignToToolGroupBoundary(nonSystem, splitIndex)

  // 一次 O(N) 前缀和，避免对每个工具组重复扫描 user 计数
  const userTurnPrefix = buildUserTurnPrefix(nonSystem)

  const result = context.slice()
  let i = 0

  while (i < nonSystem.length) {
    const msg = nonSystem[i]
    if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
      const groupStart = i
      const toolCallMap = new Map(msg.toolCalls.map(tc => [tc.id, tc.name]))
      const toolIndices: number[] = []
      let j = i + 1
      while (j < nonSystem.length && nonSystem[j].role === 'tool') {
        toolIndices.push(j)
        j++
      }

      // 仅处理起始位置在保护区之前的工具组
      if (groupStart < splitIndex && toolIndices.length > 0) {
        const userTurnsBefore = userTurnPrefix[groupStart]
        const toolMessages = toolIndices.map(idx => nonSystem[idx])
        const groupBytes = sumToolGroupBytes(toolMessages)
        const hasArtifact = toolMessages.some(m => m.artifactId)

        if (
          userTurnsBefore > AGING_USER_TURN_THRESHOLD &&
          (groupBytes > AGING_GROUP_BYTES_THRESHOLD || hasArtifact)
        ) {
          for (const toolIdx of toolIndices) {
            const toolMsg = nonSystem[toolIdx]
            const toolName = toolCallMap.get(toolMsg.toolCallId ?? '') ?? 'unknown'
            const ctxIndex = nonSystemIndices[toolIdx]
            result[ctxIndex] = {
              ...toolMsg,
              content: buildAgedPlaceholder(toolName, toolMsg.artifactId, toolMsg.content)
            }
          }
        }
      }

      i = j
      continue
    }
    i++
  }

  return result
}
