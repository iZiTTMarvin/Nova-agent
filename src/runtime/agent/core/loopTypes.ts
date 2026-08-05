/** Agent kernel 真实消费的运行时回调契约。 */
import type { ChatMessage } from '../../model/types'
import type { InlineBudgetResult } from '../ContextBudgetManager'
import type { ActiveToolResultPrunePolicy } from './projectRequestMessages'
import type { ToolControlSignal } from '../../tools/types'

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

import type { StopPolicyReason as StopReason } from '../../../shared/run/types'

/**
 * 停止策略命中或循环条件耗尽时的停止原因；模型自然收工时为 undefined。
 * 类型唯一来源在 shared/run（durable 终态记录复用同一联合）。
 */
export type { StopPolicyReason as StopReason } from '../../../shared/run/types'

/** shouldStopAfterTurn 返回：停止原因 + 提示文案（文案由调用方 emit） */
export interface StopDecision {
  stop: true
  reason: StopReason
  notice: string
}

export interface AgentLoopConfig {
  /** 轮数上限 */
  maxToolRounds: number
  /** 工具执行模式 */
  toolExecution: 'parallel' | 'sequential'
  maxParallelToolCalls: number
  supportsVision: boolean

  /**
   * 每轮结束后判定是否停止。返回 stop 原因或 undefined。
   * 停止提示由 kernel 在 break 前发射。
   */
  shouldStopAfterTurn?: (args: ShouldStopArgs) => Promise<StopDecision | void>

  /**
   * 模式切换成功后生成最新模式约束。循环会把它作为内部 user 控制消息追加到
   * 工具结果之后，再在同一任务中继续调用模型。
   */
  getModeTransitionInstruction?: (transition: ToolControlSignal) => string

  /**
   * 轮内预算校验（只估算，不改写）。
   * 返回结构化结果，超预算时由 runAgentLoop 控制流决定恢复策略。
   */
  enforceInlineBudget?: (messages: ChatMessage[]) => InlineBudgetResult

  /**
   * 溢出压缩回调，由门面提供。
   * 返回 true 表示压缩成功，应回到循环顶重新校验。
   */
  runOverflowCompaction?: (mode: 'standard' | 'aggressive') => Promise<boolean>

  /**
   * 当轮工具结果归档策略；未设置时投影关闭。
   * 门面负责注入实际策略（当前默认关闭）。
   */
  requestProjectionPolicy?: ActiveToolResultPrunePolicy

}
