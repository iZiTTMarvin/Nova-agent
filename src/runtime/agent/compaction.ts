/**
 * 上下文压缩模块 — 先插入再压缩策略
 *
 * 参考 openclacky 的 message_compressor 设计：
 * 1. 检测上下文是否超过阈值
 * 2. 将压缩指令追加到消息尾部（不改前缀 → 压缩调用本身仍命中缓存）
 * 3. 模型输出纯文本摘要
 * 4. 用 [system, 摘要, 最近 N 条] 重建历史
 */
import type { ChatMessage } from '../model/types'
import { estimateContextTokens } from './tokenEstimator'

/** 触发压缩的 token 阈值（默认 120K），当未提供 contextWindow 时作为 fallback */
export const COMPACTION_THRESHOLD = 120_000

/** 压缩后保留的最近消息数 */
export const MIN_RECENT_MESSAGES = 20

/** 压缩指令消息的内部标记，用于 UI 过滤和缓存断点跳过 */
export const COMPACTION_MARKER = '__compaction_instruction__'

/**
 * 计算动态压缩阈值：模型上下文窗口的 80%
 */
export function getCompactionThreshold(contextWindow: number): number {
  return Math.floor(contextWindow * 0.8)
}

/**
 * 判断当前上下文是否需要压缩
 */
export function shouldCompact(
  context: ChatMessage[],
  threshold: number = COMPACTION_THRESHOLD
): boolean {
  if (context.length <= MIN_RECENT_MESSAGES + 2) return false
  return estimateContextTokens(context) > threshold
}

/**
 * 构建压缩指令文本
 * 告诉模型对旧消息生成摘要
 */
export function buildCompactionPrompt(recentCount: number): string {
  return [
    '请对上面的对话历史生成一份简洁的摘要。',
    '摘要应保留：关键决策、文件修改、工具执行结果、用户意图和当前任务状态。',
    '摘要应丢弃：冗余的思考过程、重复的工具输出、过时的中间状态。',
    `摘要之后，对话将从最近 ${recentCount} 条消息继续。`,
    '请直接输出摘要文本，不要加任何前缀说明。'
  ].join('\n')
}

/**
 * 用压缩摘要重建上下文
 *
 * 将摘要合并到 system 消息尾部而非作为独立 user 消息：
 * - system prompt 前半部分（原始 ~350 tokens）逐字节不变，Anthropic 前缀匹配可命中缓存
 * - 只有后半部分（摘要 ~200-500 tokens）需要 cache_write
 * - 后续轮次中完整的 system（prompt + 摘要）也可以持续命中
 *
 * @param systemPrompt 冻结的 system prompt
 * @param summary 模型生成的摘要文本
 * @param recentMessages 保留的最近 N 条消息
 * @returns 重建后的上下文
 */
export function rebuildWithCompression(
  systemPrompt: string,
  summary: string,
  recentMessages: ChatMessage[]
): ChatMessage[] {
  const context: ChatMessage[] = []

  // 摘要合并到 system 消息尾部，保持 system prompt 前缀不变以命中缓存
  context.push({
    role: 'system',
    content: `${systemPrompt}\n\n[对话历史摘要]\n${summary}`
  })

  // 追加最近 N 条消息
  context.push(...recentMessages)

  return context
}

/**
 * 从上下文中提取需要压缩的旧消息和保留的最近消息
 *
 * 切点会对齐到工具调用组边界，避免切碎 assistant(toolCalls) + tool(result) 配对，
 * 防止重建后出现孤儿 tool 消息导致 API 400 错误。
 *
 * @returns [oldMessages, recentMessages] 元组
 */
export function splitForCompaction(
  context: ChatMessage[],
  recentCount: number = MIN_RECENT_MESSAGES
): [ChatMessage[], ChatMessage[]] {
  const nonSystemMessages = context.filter(m => m.role !== 'system')

  if (nonSystemMessages.length <= recentCount) {
    return [[], nonSystemMessages]
  }

  let splitIndex = nonSystemMessages.length - recentCount

  // 向前对齐到工具调用组边界：
  // 如果切点落在 tool 消息上，说明它属于前面某个 assistant(toolCalls) 的配对，
  // 需要把切点前移到该 assistant 消息之前，保证整个组都在同一侧。
  splitIndex = alignToToolGroupBoundary(nonSystemMessages, splitIndex)

  return [
    nonSystemMessages.slice(0, splitIndex),
    nonSystemMessages.slice(splitIndex)
  ]
}

/**
 * 将切点前移到工具调用组边界
 *
 * 工具调用组的结构：assistant(带 toolCalls) + 若干 tool 消息
 * 如果切点落在组内（tool 消息或带 toolCalls 的 assistant），前移到组起始位置之前
 */
function alignToToolGroupBoundary(messages: ChatMessage[], splitIndex: number): number {
  // 从切点位置向前扫描，如果当前消息是 tool 角色，继续前移
  while (splitIndex > 0 && messages[splitIndex]?.role === 'tool') {
    splitIndex--
  }

  // 如果前移后落到了带 toolCalls 的 assistant 上，也要把它纳入 recent 侧
  if (
    splitIndex > 0 &&
    messages[splitIndex]?.role === 'assistant' &&
    messages[splitIndex]?.toolCalls &&
    messages[splitIndex].toolCalls!.length > 0
  ) {
    splitIndex--
  }

  return Math.max(0, splitIndex)
}
