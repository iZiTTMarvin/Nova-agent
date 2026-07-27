/**
 * AgentTurnOutcome — 单条消息轮次的结构化终态。
 *
 * sendMessage 的返回契约：轮次一旦开始（messageId 已分配、状态已置位），
 * 无论成功、取消还是失败都必须 resolve 为一个 outcome，绝不以 rejection
 * 表达轮次失败——Promise resolved 不等于成功，消费方必须读 status。
 *
 * 与持久化终态事件一一对应：
 * - completed / cancelled → message_end（cancelled 附 interrupted）
 * - failed → error（携带原始错误；error 之后不得再补发 message_end）
 */
export type AgentTurnOutcome =
  | { status: 'completed' }
  | { status: 'cancelled' }
  | { status: 'failed'; error: Error }
