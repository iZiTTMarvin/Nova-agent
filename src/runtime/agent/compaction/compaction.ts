/**
 * 上下文压缩模块 — 先插入再压缩策略
 *
 * 参考 openclacky 的 message_compressor 设计：
 * 1. 检测上下文是否超过阈值
 * 2. 将压缩指令追加到消息尾部（不改前缀 → 压缩调用本身仍命中缓存）
 * 3. 模型输出纯文本摘要
 * 4. 用 [system, 摘要, 最近 N 条] 重建历史
 */
import type { ChatMessage } from '../../model/types'
import type { CacheProfile } from '../../model/cacheProfile'
import { estimateContextTokens } from '../tokenEstimator'

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

/** 软触发：工具消息 token 占阈值比例 */
export const SOFT_COMPACTION_TOOL_RATIO = 0.4
/** 软触发：总上下文 token 占阈值比例 */
export const SOFT_COMPACTION_TOTAL_RATIO = 0.6
/** 软触发：距上次压缩至少经过的用户回合数 */
export const SOFT_COMPACTION_COOLDOWN_TURNS = 5

/**
 * 空闲压缩资格：当前 token 估算须至少达到硬阈值的此比例，否则不调度摘要请求。
 * 避免短但消息多的会话产生无意义的后台摘要调用。
 */
export const IDLE_COMPACTION_MIN_THRESHOLD_RATIO = 0.6

/**
 * 空闲压缩资格预筛的输入状态。
 * profile / idlePolicy 入口已预留；本轮只做中性判断，不按档案差异化。
 * T3-2 按 idlePolicy 差异化调度。
 */
export interface IdleCompactionScheduleState {
  /** 当前会话上下文（用于 token 估算；不要仅用消息条数做资格判断） */
  context: ChatMessage[]
  /** 模型上下文窗口，用于 getCompactionThreshold */
  contextWindow: number
  /** 可选预估 token；缺省时对 context 现场估算 */
  estimatedTokens?: number
  /** 是否已有进行中的空闲压缩 */
  idleCompactionInProgress: boolean
  /** AgentLoop 已 dispose 时阻断调度 */
  disposed: boolean
  /**
   * 缓存档案或仅含 idlePolicy 的片段。
   * 本轮内部不读此字段；T3-2 按 idlePolicy 差异化调度。
   */
  profile?: Pick<CacheProfile, 'idlePolicy'> | CacheProfile | null
}

/**
 * 空闲压缩资格预筛：返回 false 时不得进入摘要模型请求。
 *
 * 中性判断（本轮）：
 * - disposed / 已有进行中压缩 → 否
 * - 距硬阈值太远（token < threshold * 60%）→ 否
 *
 * 注意：splitForCompaction 的 oldMessages=[] 是 runCompaction 内的后置空操作保护，
 * 不是本函数的前置预筛。不要只用消息数量判断资格。
 *
 * @param state 调度状态；profile 入口已预留供 T3-2 使用
 */
export function shouldScheduleIdleCompaction(state: IdleCompactionScheduleState): boolean {
  // T3-2 按 idlePolicy 差异化调度；本轮故意不消费 profile，仅保留签名入口
  void state.profile

  if (state.disposed) return false
  if (state.idleCompactionInProgress) return false

  const threshold = getCompactionThreshold(state.contextWindow)
  if (threshold <= 0) return false

  const totalTokens = state.estimatedTokens ?? estimateContextTokens(state.context)
  // 硬阈值距离：离 getCompactionThreshold 太远时不压缩
  if (totalTokens < threshold * IDLE_COMPACTION_MIN_THRESHOLD_RATIO) return false

  return true
}

/**
 * 估算上下文中 role:'tool' 消息的 token 数
 */
export function estimateToolMessageTokens(context: ChatMessage[]): number {
  const toolMessages = context.filter(m => m.role === 'tool')
  if (toolMessages.length === 0) return 0
  return estimateContextTokens(toolMessages)
}

/**
 * 判断当前上下文是否需要压缩
 *
 * - 硬触发：总 token > threshold（contextWindow 的 80%），无视冷却
 * - 软触发：工具 token > 40% threshold 且总 token > 60% threshold 且冷却 >= 5 user 回合
 *
 * @param userTurnsSinceCompaction 距上次压缩后的 user 消息数；默认 0（保守，软触发冷却不足）
 */
export function shouldCompact(
  context: ChatMessage[],
  threshold: number = COMPACTION_THRESHOLD,
  estimatedTokens?: number,
  userTurnsSinceCompaction: number = 0
): boolean {
  if (context.length <= MIN_RECENT_MESSAGES + 2) return false
  const totalTokens = estimatedTokens ?? estimateContextTokens(context)

  // 硬 cap：超过 80% 阈值立即压缩
  if (totalTokens > threshold) return true

  // 软触发需满足冷却
  if (userTurnsSinceCompaction < SOFT_COMPACTION_COOLDOWN_TURNS) return false

  const toolTokens = estimateToolMessageTokens(context)
  return (
    toolTokens > threshold * SOFT_COMPACTION_TOOL_RATIO &&
    totalTokens > threshold * SOFT_COMPACTION_TOTAL_RATIO
  )
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
    '遇到含 artifact:// 的工具结果时，摘要里只保留结论，不要复述大段输出。',
    '摘要中可保留 artifact:// 指针，供后续 read 续读。',
    '摘要开头请用一行注明当前工作区绝对路径（Working directory），让后续对话能继续基于该路径操作。',
    `摘要之后，对话将从最近 ${recentCount} 条消息继续。`,
    '请直接输出摘要文本，不要加任何前缀说明。'
  ].join('\n')
}

/**
 * 构建追加到压缩请求尾部的指令消息序列。
 *
 * 主动阈值压缩（runCompaction）与反应式溢出压缩（runOverflowCompaction）共用此逻辑，
 * 避免两处各维护一份桥接/指令拼装而产生分叉。返回的是「要追加到上下文末尾的消息」，
 * 不含原始上下文本身——调用方自行决定是拼成新数组还是 push 进 this.context。
 *
 * 关键约束（why）：
 * - 当上下文末尾是 user 消息时，先插一条 assistant 占位桥接。否则连续两条 user
 *   会被 Anthropic 严格模式拒绝。
 * - 压缩指令标记 internal：跳过缓存断点标记，但压缩调用会显式放行其正文
 *   （includeInternalMessages），让模型真正看到摘要要求；序列化层仍会剥离 internal 字段。
 *
 * @param lastMessageRole 当前上下文最后一条消息的 role（用于判断是否需要桥接）
 * @param recentCount 压缩后保留的最近消息数，用于在指令文案中告知模型续接位置
 */
export function buildCompactionRequestTail(
  lastMessageRole: ChatMessage['role'] | undefined,
  recentCount: number
): ChatMessage[] {
  const needsAssistantBridge = lastMessageRole === 'user'
  return [
    ...(needsAssistantBridge
      ? [{ role: 'assistant' as const, content: '好的，我来总结之前的对话。' }]
      : []),
    { role: 'user' as const, content: buildCompactionPrompt(recentCount), internal: true }
  ]
}

/**
 * 用压缩摘要重建上下文
 *
 * 将摘要合并到 system 消息尾部而非作为独立 user 消息：
 * - system prompt 前半部分（原始 ~350 tokens）逐字节不变，Anthropic 前缀匹配可命中缓存
 * - 只有后半部分（摘要 ~200-500 tokens）需要 cache_write
 * - 后续轮次中完整的 system（prompt + 摘要）也可以持续命中
 *
 * @param frozenSystemPrompt 冻结的 system prompt（会话级不变）
 * @param summary 模型生成的摘要文本
 * @param recentMessages 保留的最近 N 条消息
 * @returns 重建后的上下文
 */
export function rebuildWithCompression(
  frozenSystemPrompt: string,
  summary: string,
  recentMessages: ChatMessage[],
  pulledBackMessages?: ChatMessage[]
): ChatMessage[] {
  const context: ChatMessage[] = []

  // 摘要合并到 system 消息尾部，保持 system prompt 前缀不变以命中缓存。
  // summary 是纯文本，不含 reasoningContent 字段。
  context.push({
    role: 'system',
    content: `${frozenSystemPrompt}\n\n[对话历史摘要]\n${summary}`
  })

  // 追加最近 N 条消息（保留 reasoningContent，以便继续工具链 / 前缀匹配）
  context.push(...recentMessages)

  // 如果有被弹出的消息，追加入重建后的上下文尾部
  if (pulledBackMessages && pulledBackMessages.length > 0) {
    context.push(...pulledBackMessages)
  }

  return context
}

/**
 * 剥离 ChatMessage.reasoningContent，供压缩摘要请求使用。
 * 摘要文本本身不应携带思考正文；recentMessages / snapshot 仍保留原始 reasoning。
 * 无 reasoningContent 时返回原数组引用，避免无谓的对象复制。
 */
export function stripReasoningContent(messages: ChatMessage[]): ChatMessage[] {
  let changed = false
  const next = messages.map(m => {
    if (m.reasoningContent === undefined) return m
    changed = true
    const { reasoningContent: _stripped, ...rest } = m
    return rest
  })
  return changed ? next : messages
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
export function alignToToolGroupBoundary(messages: ChatMessage[], splitIndex: number): number {
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
