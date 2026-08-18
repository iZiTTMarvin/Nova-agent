/**
 * 记忆候选提炼 prompt 模板。
 * LLM 只输出候选语义（kind/scopeHint/key/content/explicitness/intent/confidence/evidence），
 * 最终落库操作由确定性 policy 决定；prompt 因此禁止输出 status/supersedesId 等裁决字段。
 */
import type { ChatMessage } from '../../model/types'
import { extractTextFromContent } from '../../model/types'
import type { MemoryObservation } from '../ObservationCapture'
import { MEMORY_CANDIDATE_CONTENT_MAX_CHARS } from '../memoryConfig'

const SYSTEM_PROMPT = `你是长期记忆提炼助手。从对话与工具轨迹中提取「值得长期记住的候选记忆」，输出候选而非最终裁决。

严格输出 JSON 数组，不要 markdown 代码块，不要任何说明文字。每个元素的字段：
- kind："preference" | "convention" | "project_fact" | "decision" | "workflow" | "gotcha"
- scopeHint："project"（仅当前项目成立的事实/约定/偏好）| "global"（跨项目稳定的用户习惯/偏好）
- key：稳定事实的简短小写标识（如 "database.primary"、"commit.style"）；无稳定身份（如一次性踩坑经验）为 null
- content：一句话自包含的客观陈述（中文，不超过 ${MEMORY_CANDIDATE_CONTENT_MAX_CHARS} 字）
- explicitness："user_explicit"（用户明确表达）| "workspace_verified"（工具结果/工作区文件可证实）| "observed"（行为模式观察）| "inferred"（推断）
- intent："assert"（确认或新增）| "negate"（用户明确否定、撤回某既有偏好）
- confidence：0 到 1 的小数
- evidence：数组，每项 {"type": "user_message" | "tool_result" | "workspace", "excerpt": "原文逐字摘录"}

硬性规则：
- excerpt 必须逐字摘自输入：type 为 user_message 时只能摘自「用户」消息；type 为 tool_result / workspace 时只能摘自「工具轨迹」或工具消息；禁止摘自「助手」回复
- 不推断助手自己提出且用户未确认的偏好；不从单次使用推导长期偏好
- 仅在当前项目成立的架构事实、技术选型、项目约定，scopeHint 必须用 "project"，不得标 "global"
- 用户明确否定、撤回某既有偏好的条目 intent 用 "negate"
- 普通闲聊、一次性任务描述、大段代码正文、密钥/凭据相关内容一律不提取
- 无值得记录的内容时输出 []`

export interface ExtractionPromptInput {
  sessionId: string
  messages: readonly ChatMessage[]
  observations: readonly MemoryObservation[]
}

/** 将会话消息与 observation 格式化为 user 侧提炼输入 */
export function formatExtractUserContent(input: ExtractionPromptInput): string {
  const lines: string[] = [`## 会话 ${input.sessionId} 最近对话（节选）`, '']

  for (const msg of input.messages) {
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

  lines.push('请按系统指令输出候选 JSON 数组。')
  return lines.join('\n')
}

/** 构建提炼用的 messages（system + user） */
export function buildExtractMessages(input: ExtractionPromptInput): ChatMessage[] {
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: formatExtractUserContent(input)
    }
  ]
}
