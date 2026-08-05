/**
 * AgentTurnOutcome — 单条消息轮次的结构化终态。
 *
 * sendMessage 的返回契约：轮次一旦开始（messageId 已分配、状态已置位），
 * 无论成功、取消还是失败都必须 resolve 为一个 outcome，绝不以 rejection
 * 表达轮次失败——Promise resolved 不等于成功，消费方必须读 status。
 *
 * 与持久化终态事件一一对应：
 * - completed / incomplete / cancelled → message_end（cancelled 附 interrupted；
 *   incomplete 表示轮次确实结束但被停止策略截断，与 completed 一样不附 interrupted）
 * - failed → error（携带原始错误；error 之后不得再补发 message_end）
 *
 * durable run 终态映射见 reconcileAgentTurnTerminal：incomplete 按 completed 收，
 * 不扩展 durable 状态枚举。
 */

import type { TurnTruncationReason as IncompleteReason } from '../../../shared/run/types'

/**
 * 轮次未完成的原因：停止策略截断，或宿主 deadline 到期。
 * 类型唯一来源在 shared/run（durable 终态记录复用同一联合）。
 */
export type { TurnTruncationReason as IncompleteReason } from '../../../shared/run/types'

export type AgentTurnOutcome =
  | { status: 'completed' }
  | { status: 'incomplete'; reason: IncompleteReason }
  | { status: 'cancelled' }
  | { status: 'failed'; error: Error }
