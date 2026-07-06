/**
 * 记忆 LLM 提炼 prompt 模板（独立文件，便于迭代）
 */
import type { ChatMessage } from '../model/types'
import { extractTextFromContent } from '../model/types'
import type { MemoryObservation } from './ObservationCapture'

/** 硬编码：滑动窗口最近 N 条消息 */
export const EXTRACT_WINDOW_SIZE = 50

const SYSTEM_PROMPT = `你是项目记忆提炼助手。请从对话与工具轨迹中蒸馏出有长期价值的结论，而非操作流水账。

输出要求：
- 严格输出 JSON 数组，不要 markdown 代码块，不要额外说明
- 每个元素必须包含 6 个字符串字段：userNeed、approach、outcome、whatFailed、whatWorked、tags
- tags 为字符串数组（实体/主题标签，可为空数组）
- 忽略「读了 README、跑了 ls」类无信息操作；聚焦需求、方案、结果、踩坑、有效做法
- 若无值得记录的内容，输出空数组 []`

/**
 * 将会话消息与 observation 格式化为 user 侧提炼输入
 */
export function formatExtractUserContent(input: {
  recentMessages: ChatMessage[]
  observations: readonly MemoryObservation[]
}): string {
  const lines: string[] = ['## 最近对话（节选）', '']

  const windowed = input.recentMessages.slice(-EXTRACT_WINDOW_SIZE)
  for (const msg of windowed) {
    const text = extractTextFromContent(msg.content).trim()
    if (!text) {
      continue
    }
    const role = msg.role === 'user' ? '用户' : msg.role === 'assistant' ? '助手' : msg.role
    lines.push(`[${role}] ${text.slice(0, 2000)}`)
    lines.push('')
  }

  if (input.observations.length > 0) {
    lines.push('## 工具轨迹（节选）', '')
    for (const obs of input.observations) {
      lines.push(`- ${obs.title}`)
      for (const fact of obs.facts) {
        lines.push(`  - ${fact}`)
      }
      if (obs.filesTouched.length > 0) {
        lines.push(`  - 文件: ${obs.filesTouched.join(', ')}`)
      }
      lines.push('')
    }
  }

  lines.push('请提炼为 JSON 数组。')
  return lines.join('\n')
}

/** 构建提炼用的 messages（system + user） */
export function buildExtractMessages(input: {
  recentMessages: ChatMessage[]
  observations: readonly MemoryObservation[]
}): ChatMessage[] {
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: formatExtractUserContent(input)
    }
  ]
}
