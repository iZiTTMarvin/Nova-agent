/**
 * 上下文压缩：切点、摘要指令与重建。
 * 切点按 token 预算；重建用冻结 system + 只读交接包 + 原文尾部。
 */
import type { ChatMessage } from '../../model/types'
import type { CompactionLedger, LedgerEntry } from '../../sessions'
import type { CacheProfile } from '../../model/cacheProfile'
import { CHARS_PER_TOKEN, estimateChatMessageTokens, estimateContextTokens, estimateTokens } from '../tokenEstimator'
import { formatPointerStub, renderCompactedSystem, renderLedgerEntry } from '../core/renderHandoffPacket'

/** 触发压缩的 token 阈值（默认 120K），当未提供 contextWindow 时作为 fallback */
export const COMPACTION_THRESHOLD = 120_000

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
 * profile.idlePolicy 决定是否允许闲时调度（见 shouldScheduleIdleCompaction）。
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
   * null/undefined 按 unknown 处理（保守跳过闲时压缩）。
   */
  profile?: Pick<CacheProfile, 'idlePolicy'> | CacheProfile | null
}

/**
 * 空闲压缩资格预筛：返回 false 时不得进入摘要模型请求。
 *
 * 判断顺序：
 * - disposed / 已有进行中压缩 → 否
 * - idlePolicy：
 *   - provider-managed → 否（依赖服务端前缀缓存，不主动摘要打碎前缀）
 *   - unknown / profile 缺失 → 否（缓存语义不明时保守跳过）
 *   - anthropic-short-ttl → 继续 token 阈值判断（短 TTL 需闲时刷新）
 * - 距硬阈值太远（token < threshold * 60%）→ 否
 *
 * 注意：splitForCompactionByTokens 的 oldMessages=[] 是 runCompaction 内的后置空操作保护，
 * 不是本函数的前置预筛。不要只用消息数量判断资格。
 * 硬阈值压缩、溢出恢复、用户显式压缩不经过本函数。
 */
export function shouldScheduleIdleCompaction(state: IdleCompactionScheduleState): boolean {
  if (state.disposed) return false
  if (state.idleCompactionInProgress) return false

  const idlePolicy = state.profile?.idlePolicy ?? 'unknown'
  if (idlePolicy === 'provider-managed' || idlePolicy === 'unknown') {
    return false
  }

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
  const nonSystemCount = context.filter(message => message.role !== 'system').length
  if (nonSystemCount < 2) return false
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
 * 构建 state 文档压缩指令。
 * 五段顺序把「下一步」「关键上下文」放在「进展 / 关键决策」之前，超预算从末尾截时先保住接续信息。
 */
export function buildCompactionPrompt(): string {
  return [
    '请对上面的对话历史生成结构化交接，只输出完整 JSON，不继续对话。',
    'schemaVersion=1；goal（目标）、nextActions（下一步）、keyContext（关键上下文）、progress（进展）、decisions（关键决策）均为非空字符串；没有内容写 (none)。',
    'facts 为事实数组。每项包含 id、category、owner、value、origin{messageId,step}、quote、required。',
    '保留系统列出的所有必需事实及归属；只引用有来源的原始 user 原句。不得虚构已完成或已验证结论。',
    '丢弃重复工具正文、冗余思考；保留必要 artifact:// 指针。工作区和文件清单由系统提供。'
  ].join('\n')
}

/** stub 短摘要估算 token 上限 */
export const MAX_STUB_ESTIMATED_TOKENS = 200

/** 账本条目渲染占窗口的上限比例；超出由代码把最旧条目折成一行指针 */
export const LEDGER_RENDER_WINDOW_RATIO = 0.025

/** 尾部原文约占窗口的比例 */
export const TAIL_WINDOW_RATIO = 0.15

/** state 文档占窗口的中位比例；再夹到 [1200, 4000] */
export const STATE_WINDOW_RATIO = 0.015
export const MIN_STATE_ESTIMATED_TOKENS = 1_200
export const MAX_STATE_ESTIMATED_TOKENS = 4_000

export function getTailTokenBudget(contextWindow: number): number {
  return Math.max(1, Math.floor(contextWindow * TAIL_WINDOW_RATIO))
}

export function getStateTokenBudget(contextWindow: number): number {
  return Math.min(
    MAX_STATE_ESTIMATED_TOKENS,
    Math.max(MIN_STATE_ESTIMATED_TOKENS, Math.floor(contextWindow * STATE_WINDOW_RATIO))
  )
}

export function buildRealityLine(
  workspacePath: string | null | undefined,
  activePlanPath: string | null | undefined
): string {
  const workspace = workspacePath?.trim() || '(未知)'
  const plan = activePlanPath?.trim()
  const planPart = plan ? `；计划: ${plan}` : ''
  return (
    `工作区: ${workspace}${planPart}。` +
    '被折叠区间改过的文件见各条目（含本会话 checkpoint 记录的 bash 变更；不含编辑器手改与因过大跳过备份的文件）。' +
    '继续修改前请重新读取确认现状。'
  )
}

/** stub：只叙述被折叠区间的事件，不写目标/下一步 */
export function buildStubPrompt(): string {
  return [
    '请只总结上面被折叠的这一段对话里实际发生的事件。不要继续对话。',
    '不要写目标、下一步、全局状态或工作记忆。',
    '用 2–3 行叙述关键事件，最后单独一行给出一个字面锚点（错误信息、文件路径、命令或数值）。',
    '只输出这段摘要，不要加任何前缀说明。'
  ].join('\n')
}

export function buildStateInstruction(previousState?: string): string {
  const base = buildCompactionPrompt()
  if (!previousState) return base
  return [
    base,
    '',
    '前序摘要如下，请在它的基础上只更新新增事件与发生的变化，不要推翻重写仍然成立的部分：',
    previousState
  ].join('\n')
}

/** 摘要估算 token 上限：防止坏摘要无限膨胀挤占上下文，超出后在行边界截断 */
export const MAX_SUMMARY_ESTIMATED_TOKENS = 768

/**
 * 按估算 token 上限约束摘要文本。
 * 超限时在上限内最后一个换行处截断（无换行则硬截），末尾追加省略标记；
 * 未超限原样返回。80 字符下限防止 maxTokens 过小时截成空串。
 */
export function boundSummaryText(
  summary: string,
  maxTokens: number = MAX_SUMMARY_ESTIMATED_TOKENS
): string {
  const maxChars = Math.max(80, Math.floor(maxTokens * CHARS_PER_TOKEN))
  if (summary.length <= maxChars) return summary
  const lineBreak = summary.lastIndexOf('\n', maxChars)
  const cutAt = lineBreak > 0 ? lineBreak : maxChars
  return `${summary.slice(0, cutAt)}\n…[摘要已截断]`
}

/**
 * 用冻结 system + 交接包 + 尾部重建上下文。
 * 交接包由账本只读渲染；禁止把当前 system 正文（可能已含交接包）再叠一层。
 */
export function rebuildWithCompression(
  frozenSystemPrompt: string,
  ledger: CompactionLedger,
  tail: ChatMessage[]
): ChatMessage[] {
  return [
    { role: 'system', content: renderCompactedSystem(frozenSystemPrompt, ledger) },
    ...tail
  ]
}

/**
 * 构建追加到压缩请求尾部的指令消息序列。
 *
 * 主动阈值压缩与反应式溢出压缩共用此逻辑。
 * 当上下文末尾是 user 时先插一条 assistant 占位桥接，避免连续两条 user。
 */
export function buildCompactionRequestTail(
  lastMessageRole: ChatMessage['role'] | undefined,
  instruction: string
): ChatMessage[] {
  const needsAssistantBridge = lastMessageRole === 'user'
  return [
    ...(needsAssistantBridge
      ? [{ role: 'assistant' as const, content: '好的，我来总结之前的对话。' }]
      : []),
    { role: 'user' as const, content: instruction, internal: true }
  ]
}

/**
 * 账本条目渲染超预算时，从最旧条目起折成一行指针（保留 id 与 touchedFiles）。
 * 预算按交接包里实际渲染的条目文本估算，含 touchedFiles。
 */
export function foldLedgerEntriesToBudget(
  entries: LedgerEntry[],
  maxEstimatedTokens: number
): LedgerEntry[] {
  const next = entries.map(entry => ({ ...entry }))
  const renderedTokens = (): number =>
    estimateTokens(next.map(entry => renderLedgerEntry(entry)).filter(Boolean).join('\n\n'))
  if (maxEstimatedTokens <= 0) {
    return next.map(entry => ({
      ...entry,
      stub: formatPointerStub(entry.id, entry.shadows.from, entry.shadows.to)
    }))
  }
  for (let i = 0; i < next.length && renderedTokens() > maxEstimatedTokens; i++) {
    const entry = next[i]!
    next[i] = {
      ...entry,
      stub: formatPointerStub(entry.id, entry.shadows.from, entry.shadows.to)
    }
  }
  return next
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
 * 从上下文中按 token 预算切出尾部原文，切点对齐工具调用组。
 * 下限为当前工具组（至少保留一组完整原文）。
 */
export function splitForCompactionByTokens(
  context: ChatMessage[],
  tailTokenBudget: number,
  extraTailTokens = 0
): { oldMessages: ChatMessage[]; recentMessages: ChatMessage[] } {
  const nonSystemMessages = context.filter(m => m.role !== 'system')
  const budget = Math.max(1, tailTokenBudget + extraTailTokens)
  let splitIndex = nonSystemMessages.length
  let acc = 0
  while (splitIndex > 0) {
    const message = nonSystemMessages[splitIndex - 1]!
    const tokens = estimateChatMessageTokens(message)
    if (acc > 0 && acc + tokens > budget) break
    acc += tokens
    splitIndex--
  }
  splitIndex = alignToToolGroupBoundary(nonSystemMessages, splitIndex)
  if (splitIndex >= nonSystemMessages.length && nonSystemMessages.length > 0) {
    splitIndex = alignToToolGroupBoundary(nonSystemMessages, nonSystemMessages.length - 1)
  }
  return {
    oldMessages: nonSystemMessages.slice(0, splitIndex),
    recentMessages: nonSystemMessages.slice(splitIndex)
  }
}

/** 将切点前移到工具调用组起点，确保 assistant(toolCalls) 与 tool 结果同在尾部。 */
export function alignToToolGroupBoundary(messages: ChatMessage[], splitIndex: number): number {
  // 从切点位置向前扫描，如果当前消息是 tool 角色，继续前移
  while (splitIndex > 0 && messages[splitIndex]?.role === 'tool') {
    splitIndex--
  }


  return Math.max(0, splitIndex)
}
