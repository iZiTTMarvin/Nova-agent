/**
 * 同会话连发消息的排队队列（steering queue）。
 *
 * 并发模型下同一会话同时只允许一个 active turn。当该会话的 turn 正在跑时，
 * 用户再次发送的消息不直接拒绝，而是按发送顺序进入该会话的队列；当前 turn
 * 到达终态后，由 AgentTurnService 取出队首消息发起新 turn。
 *
 * 设计要点：
 * - 纯运行时内存结构，不持久化。进程重启后队列丢失（可接受：未处理的消息未落盘为 user 消息）。
 * - 按会话分桶，不同会话的队列互不影响。
 * - FIFO 顺序保证用户感知的发送顺序。
 */

/** 队列项：与 SEND_MESSAGE 入参对齐，但不依赖 AgentTurnService 类型，避免循环导入。 */
export interface SteeringMessage {
  sessionId: string
  content: string
  userMessageId?: string
  images?: Array<{ fileName: string; data: string; mimeType: string }>
  regenerate?: boolean
}

const queuesBySession = new Map<string, SteeringMessage[]>()

/** 把一条消息追加到指定会话的队尾。 */
export function enqueueSteeringMessage(
  sessionId: string,
  message: SteeringMessage
): void {
  let q = queuesBySession.get(sessionId)
  if (!q) {
    q = []
    queuesBySession.set(sessionId, q)
  }
  // 锁定归属当前会话，避免后续递归 send 时 sessionId 与队列键不一致
  q.push({ ...message, sessionId })
}

/** 取出（并移除）指定会话的队首消息；队列为空返回 undefined。 */
export function dequeueSteeringMessage(
  sessionId: string
): SteeringMessage | undefined {
  const q = queuesBySession.get(sessionId)
  if (!q || q.length === 0) return undefined
  const head = q.shift()
  if (q.length === 0) {
    queuesBySession.delete(sessionId)
  }
  return head
}

/** 指定会话队列是否非空。 */
export function hasSteeringMessage(sessionId: string): boolean {
  const q = queuesBySession.get(sessionId)
  return !!q && q.length > 0
}

/** 清空指定会话的队列（会话删除 / 取消时调用）。 */
export function clearSteeringQueue(sessionId: string): void {
  queuesBySession.delete(sessionId)
}

/** 测试用：重置全部队列。 */
export function resetSteeringQueueForTests(): void {
  queuesBySession.clear()
}
