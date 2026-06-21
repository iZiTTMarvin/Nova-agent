/**
 * 稳定的 system prompt —— 与模式无关，会话级冻结。
 *
 * 角色、工作区提示、模式说明在这里拼装。
 * 工具目录由 SystemPromptBuilder 的 toolSummary 层单独注入，避免与 agentRole 重复。
 * 具体模式约束由每轮 user 消息尾部附加，这样切模式只改尾部，前面整条
 * 历史的缓存前缀全部保留。
 */
import { renderWorkingDirectoryHint } from './toolPromptRenderer'

export interface BuildStableSystemPromptOptions {
  /** 工作区绝对路径 */
  workingDir?: string
}

const STABLE_SYSTEM_PROMPT: BuildStableSystemPromptOptions = {}

export function buildStableSystemPrompt(options: BuildStableSystemPromptOptions): string {
  const parts: string[] = []
  parts.push('你是 Nova 的编程助手。')
  parts.push('你要基于当前工作区和工具结果回答，保持诚实、具体、可执行。')

  if (options.workingDir) {
    parts.push('', renderWorkingDirectoryHint(options.workingDir))
  }

  parts.push(
    '',
    'Nova 有三种运行模式，当前激活的模式会在每轮对话中告知你：',
    '- plan 模式：只读规划。你只能读取和分析项目，不能编辑、写入或执行命令。',
    '- default 模式：标准模式。你可以读取、修改和验证工作区，高风险操作需审批。',
    '- auto 模式：主动模式。你可以更主动地推进实现和验证，但仍遵守安全边界。',
    '',
    '请严格遵守当前模式的约束。如果在 plan 模式下被要求写入，请说明需要切换模式。'
  )

  return parts.join('\n')
}

/** 兼容旧 API：返回默认 native 方言 prompt（无工具、无工作区）。 */
export function getStableSystemPrompt(): string {
  return buildStableSystemPrompt(STABLE_SYSTEM_PROMPT)
}

/**
 * 旧版冻结 prompt 里有两类已知问题：
 * 1. 完全没提 session context（模型只能靠工具输出猜工作区）
 * 2. 明确写错了注入时机（v2 写成"每条消息都会带前缀"）
 * 3. 旧 prompt 没有区分模型方言，对 MiniMax 等模型要求走原生 tool_call
 *
 * 这里做定点归一化：只替换这些已知旧 prompt，避免旧会话持续带着错误说明运行；
 * 其他自定义或未来版本 prompt 一律保持原样，不扩大影响面。
 */
const LEGACY_STABLE_SYSTEM_PROMPTS = new Set([
  // v2：错误宣称每条 user 消息都带 [Session context: ...] 前缀，并带旧版工具列表
  [
    '你是 Nova 的编程助手。',
    '基于当前工作区和工具结果回答，保持诚实、具体、可执行。',
    '对话开始时（以及跨天或压缩后），用户消息的开头会带一个 [Session context: ...] 前缀，给出工作区**绝对路径**（Working directory）、当前日期和模型。所有 ls/read/edit/write 等工具的相对路径都基于该绝对路径解析。',
    '不要用任何其他概念覆盖它——不要假设、不要脑补、不要因为 ls 返回相对路径就以为自己在别处。你就是在该工作区内工作。',
    '',
    '你拥有以下工具：',
    '- ls：列出目录内容',
    '- read：读取文件内容',
    '- grep：在文件中搜索内容',
    '- find：按文件名模式查找文件',
    '- edit：编辑文件（修改已有内容）',
    '- write：写入文件（创建或覆盖）',
    '- bash：执行终端命令',
    '',
    'Nova 有三种运行模式，当前激活的模式会在每轮对话中告知你：',
    '- plan 模式：只读规划。你只能读取和分析项目，不能编辑、写入或执行命令。',
    '- default 模式：标准模式。你可以读取、修改和验证工作区，高风险操作需用户审批。',
    '- auto 模式：主动模式。你可以更主动地推进实现和验证，但仍遵守安全边界。',
    '',
    '请严格遵守当前模式的约束。如果在 plan 模式下被要求写入，请说明需要切换模式。'
  ].join('\n')
])

/** 把旧会话中已知过时/错误的冻结 prompt 归一化到当前稳定版本。 */
export function normalizeFrozenSystemPrompt(prompt?: string): string {
  if (typeof prompt !== 'string' || prompt.length === 0) return getStableSystemPrompt()
  const normalized = prompt.replace(/\r\n/g, '\n')
  return LEGACY_STABLE_SYSTEM_PROMPTS.has(normalized) ? getStableSystemPrompt() : prompt
}
