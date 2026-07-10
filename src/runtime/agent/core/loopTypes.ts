/**
 * loopTypes — AgentLoop 回调扩展点契约（PRD §6.2）
 *
 * 本阶段（Phase 1）只定义类型，空实现/透传由 Phase 3 的 extensions 提供。
 * 字段命名遵循现有代码风格，与 types.ts 的 AgentLoopConfig（旧运行配置）区分。
 *
 * 设计理念（PRD §0 / §5.3）：学 pi-agent 的"具名回调扩展点"，比洋葱中间件更适配
 * nova 的重试/降级/溢出等非线性回溯控制流。
 */
import type { ChatMessage } from '../../model/types'
import type { AgentContext } from './AgentContext'

/** 压缩元数据（与 types.ts CompactionMeta 对齐，供 onCompaction 回调） */
export interface CompactionMeta {
  summary: string
  compactionLevel: number
  trigger: 'threshold' | 'overflow' | 'idle'
}

/** beforeToolCall 回调入参 */
export interface BeforeToolCallArgs {
  messageId: string
  toolCallId: string
  toolName: string
  args: Record<string, unknown>
}

/** afterToolCall 回调入参 */
export interface AfterToolCallArgs {
  messageId: string
  toolCallId: string
  toolName: string
  args: Record<string, unknown>
  resultText: string
  success: boolean
}

/** afterToolCall 回调返回（可改写结果文本、登记熔断计数） */
export interface AfterToolCallResult {
  resultText?: string
  failed?: boolean
}

/** shouldStopAfterTurn 回调入参 */
export interface ShouldStopArgs {
  messageId: string
  toolRound: number
  maxToolRounds: number
  /** 本轮工具执行结果（供熔断判定读取 failed 标记） */
  outcomes: Array<{
    toolCall: { id: string; name: string }
    args: Record<string, unknown>
    resultText: string
    failed?: boolean
    skippedByAbort?: boolean
  }>
  /** 本轮工具调用（repairEmptyArgsFromContent 之后），供空参护栏判定 */
  toolCallsThisRound?: Array<{
    name: string
    args: Record<string, unknown>
  }>
}

/** shouldStopAfterTurn 返回：停止原因 + 提示文案（文案由调用方 emit） */
export interface StopDecision {
  stop: true
  reason: 'breaker' | 'max_rounds' | 'empty_args'
  notice: string
}

/**
 * AgentLoopConfig — 回调扩展点契约（PRD §6.2）
 *
 * 每个 extension 实现其中一个回调，内部组合既有模块
 * （compaction.ts / PermissionManager / truncationPipeline / repeatedFailureCounts）。
 * Phase 3 才注入实现；Phase 1 仅定义。
 */
export interface AgentLoopConfig {
  /** 轮数上限 */
  maxToolRounds: number
  /** 工具执行模式 */
  toolExecution: 'parallel' | 'sequential'
  maxParallelToolCalls: number
  supportsVision: boolean

  /**
   * 调 LLM 前改写上下文（主动阈值压缩）。返回新的 messages。
   * 对应现状：!compressingForOverflow 时的 shouldCompact → runCompaction。
   * 注意：本回调在每轮 streamAssistant 前调用。
   */
  transformContext?: (ctx: AgentContext, signal?: AbortSignal) => Promise<void>

  /**
   * 工具执行前拦截。返回 { block, reason } 阻断；返回 { aborted } 表示被取消。
   * 对应现状：checkPermission（plan 模式 / PermissionManager / ask 等待 / PermissionAborted）。
   */
  beforeToolCall?: (
    args: BeforeToolCallArgs,
    signal?: AbortSignal
  ) => Promise<{ block?: boolean; reason?: string; aborted?: boolean } | void>

  /**
   * 工具结果后处理。可改写 resultText（截断）、登记熔断计数。
   * 对应现状：applyTruncation + trackRepeatedFailures 的计数累加。
   */
  afterToolCall?: (args: AfterToolCallArgs) => Promise<AfterToolCallResult | void>

  /**
   * 每轮结束后判定是否停止。返回 stop 原因或 undefined。
   * 对应现状：熔断命中 / toolRound>=maxToolRounds 的提示与 break。
   * 注意：停止提示文案（text_delta）由该回调通过 emit 发射，保持现状口径。
   */
  shouldStopAfterTurn?: (args: ShouldStopArgs) => Promise<StopDecision | void>

  /** 持久化压缩态回调（透传现状 config.onCompaction） */
  onCompaction?: (context: ChatMessage[], meta: CompactionMeta) => void

  /**
   * 工具批次后应用上下文硬预算。
   * 超限必须抛错，禁止继续请求模型。
   */
  applyContextBudget?: (messages: ChatMessage[]) => ChatMessage[]

  // —— future 接口位，本期不实现 ——
  getSteeringMessages?: () => Promise<ChatMessage[]>
  getFollowUpMessages?: () => Promise<ChatMessage[]>
}
