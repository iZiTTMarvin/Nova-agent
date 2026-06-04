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
 *
 * @param context 当前上下文
 * @param threshold 触发压缩的 token 阈值
 * @param estimatedTokens 可选。预先估算或上轮 API 实际返回的较新 token 计数（用于守卫判断防范反复触发）
 */
export function shouldCompact(
  context: ChatMessage[],
  threshold: number = COMPACTION_THRESHOLD,
  estimatedTokens?: number
): boolean {
  if (context.length <= MIN_RECENT_MESSAGES + 2) return false
  const tokens = estimatedTokens ?? estimateContextTokens(context)
  return tokens > threshold
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
  recentMessages: ChatMessage[],
  pulledBackMessages?: ChatMessage[]
): ChatMessage[] {
  const context: ChatMessage[] = []

  // 摘要合并到 system 消息尾部，保持 system prompt 前缀不变以命中缓存
  context.push({
    role: 'system',
    content: `${systemPrompt}\n\n[对话历史摘要]\n${summary}`
  })

  // 追加最近 N 条消息
  context.push(...recentMessages)

  // 如果有被弹出的消息，追加入重建后的上下文尾部
  if (pulledBackMessages && pulledBackMessages.length > 0) {
    context.push(...pulledBackMessages)
  }

  return context
}

/**
 * 将上下文回滚到指定索引之前
 * 参考 OpenClacky message_history.rb rollback_before
 *
 * @param context 当前上下文
 * @param markerIndex 要回滚到的位置（此位置及之后的消息被移除）
 * @returns 截断后的上下文
 */
export function rollbackBefore(context: ChatMessage[], markerIndex: number): ChatMessage[] {
  if (markerIndex < 0 || markerIndex >= context.length) return context
  return context.slice(0, markerIndex)
}

/**
 * 从上下文中提取需要压缩的旧消息和保留的最近消息
 *
 * 切点会对齐到工具调用组边界，避免切碎 assistant(toolCalls) + tool(result) 配对。
 * 支持 `pullBackFromTail` 以便在溢出时弹出末尾消息，弹出消息同样会对齐到工具调用组边界，
 * 避免破坏压缩时发送的 compactionContext 中工具调用与工具结果的完整性。
 *
 * @returns 包含 oldMessages、recentMessages 和 pulledBackMessages 的对象
 */
export function splitForCompaction(
  context: ChatMessage[],
  recentCount: number = MIN_RECENT_MESSAGES,
  pullBackFromTail: number = 0
): { oldMessages: ChatMessage[]; recentMessages: ChatMessage[]; pulledBackMessages: ChatMessage[] } {
  const nonSystemMessages = context.filter(m => m.role !== 'system')

  if (nonSystemMessages.length <= recentCount) {
    let splitIndex = nonSystemMessages.length - pullBackFromTail
    if (splitIndex < 1) splitIndex = 1 // 至少保留一条
    splitIndex = alignPullBackBoundary(nonSystemMessages, splitIndex)

    return {
      oldMessages: [],
      recentMessages: nonSystemMessages.slice(0, splitIndex),
      pulledBackMessages: nonSystemMessages.slice(splitIndex)
    }
  }

  let splitIndex = nonSystemMessages.length - recentCount
  splitIndex = alignToToolGroupBoundary(nonSystemMessages, splitIndex)

  const oldMessages = nonSystemMessages.slice(0, splitIndex)
  let recentMessages = nonSystemMessages.slice(splitIndex)

  let pulledBackMessages: ChatMessage[] = []
  if (pullBackFromTail > 0) {
    let pbIndex = recentMessages.length - pullBackFromTail
    if (pbIndex < 1) pbIndex = 1 // 至少保留一条最近消息以匹配 API 结构
    pbIndex = alignPullBackBoundary(recentMessages, pbIndex)

    pulledBackMessages = recentMessages.slice(pbIndex)
    recentMessages = recentMessages.slice(0, pbIndex)
  }

  return {
    oldMessages,
    recentMessages,
    pulledBackMessages
  }
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
  const msg = messages[splitIndex]
  if (
    splitIndex > 0 &&
    msg?.role === 'assistant' &&
    msg.toolCalls &&
    msg.toolCalls.length > 0
  ) {
    splitIndex--
  }

  return Math.max(0, splitIndex)
}

/**
 * 弹出消息时的边界对齐
 *
 * 如果切点落在 tool 消息上，或者在切点后的 tool 被弹走但带 toolCalls 的 assistant 留在 recentMessages，
 * 我们需要前移切点，把这一整组工具调用消息全部划入 pulledBackMessages，避免 recent 结尾留下孤儿 toolCalls。
 */
function alignPullBackBoundary(messages: ChatMessage[], pbIndex: number): number {
  while (pbIndex > 0 && messages[pbIndex]?.role === 'tool') {
    pbIndex--
  }

  const msg = messages[pbIndex]
  if (
    pbIndex > 0 &&
    msg?.role === 'assistant' &&
    msg.toolCalls &&
    msg.toolCalls.length > 0
  ) {
    pbIndex--
  }

  return Math.max(0, pbIndex)
}
