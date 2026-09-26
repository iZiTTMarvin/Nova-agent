import type { LearningCommand, LearningCommandReceipt } from '../../shared/learning/command'
import { parseLearningAction } from '../../shared/learning/command'
import type { LearningProgress } from '../../runtime/learning/progress/LearningProgress'
import type { SendAgentMessageDeps } from '../agent/turn/AgentTurnService'
import { isSessionTurnInProgress } from '../agent/state'

const admittedSessions = new Set<string>()

export function formatLearningTurnContent(command: Pick<LearningCommand, 'action'>): string {
  const action = command.action
  switch (action.type) {
    case 'message': return action.text
    // 停点、评估、节点等内部标识不进用户消息；模型统一经 learning_context 读取当前身份
    case 'select_node': return '[学习选点] 用户选择了新的知识节点。请读取 learning_context 获取当前节点材料，围绕它讲解并引用有效出处。'
    case 'hint': return '[学习提示] 用户请求提示。请读取 learning_context 中的当前停点，给出最小提示，不直接说答案，也不要替换原问题。'
    case 'explain': return '[学习讲解] 用户请求直接讲解。请读取 learning_context 中的当前停点，讲清机制与出处；本次讲解不作为独立理解证据。'
    case 'skip': return '[学习跳过] 用户跳过了当前问题。请读取 learning_context，简短收束并建议下一个学习点。'
    case 'dispute': return `[学习复核] 用户质疑了最新评估：${action.reason}\n读取 learning_context 中的原回答、原评估与冻结判据，先解释判断依据，再提交新的评估。`
    case 'resume': return '[继续学习] 读取 learning_context，继续已保存但尚未完成的评估，或继续当前主题。'
    case 'answer': return action.text
  }
}

export function formatOutboxDeliverContent(payloadJson: string): string {
  const payload = JSON.parse(payloadJson) as { kind: string; text?: string; action?: unknown }
  if (payload.kind === 'deliver_command') {
    return formatLearningTurnContent({ action: parseLearningAction(payload.action) })
  }
  if (payload.kind === 'deliver_answer') {
    return `[学习回答]\n${payload.text ?? ''}`
  }
  throw new Error('学习交付意图无效')
}

export interface LearningHostTurnDelivery {
  readonly userMessageId: string
  readonly content: string
  readonly commandId: string
}

export async function applyLearningCommand(
  progress: LearningProgress,
  workspaceRoot: string,
  command: LearningCommand
): Promise<{ receipt: LearningCommandReceipt; delivery: LearningHostTurnDelivery | null }> {
  await progress.getCursor(workspaceRoot, command.sessionId)
  const receipt = await progress.applyCommand(command)
  if (!receipt.ok) return { receipt, delivery: null }
  // 精确取本命令的交付意图；resume 复用最早的 pending（未绑定 run 的旧意图按原消息身份续接）
  const own = await progress.getPendingOutbox(command.sessionId, command.commandId)
  const outbox = own ?? (
    command.action.type === 'resume' ? await progress.getPendingOutbox(command.sessionId) : null
  )
  if (!outbox) {
    return { receipt, delivery: null }
  }
  return { receipt, delivery: {
    userMessageId: outbox.user_message_id,
    content: formatOutboxDeliverContent(outbox.payload_json),
    commandId: outbox.command_id
  } }
}

export async function submitLearningCommandTurn(
  progress: LearningProgress,
  workspaceRoot: string,
  command: LearningCommand,
  deps: SendAgentMessageDeps
): Promise<Awaited<ReturnType<typeof applyLearningCommand>>> {
  const sessionId = command.sessionId
  // 覆盖落库到 run 建立前的异步窗口；所有学习命令只从这个入口接纳。
  if (admittedSessions.has(sessionId) || isSessionTurnInProgress(sessionId)) {
    return { receipt: { ok: false, code: 'busy', message: '教练仍在运行，请等待或取消后再试' }, delivery: null }
  }
  admittedSessions.add(sessionId)
  try {
    const applied = await applyLearningCommand(progress, workspaceRoot, command)
    if (applied.receipt.ok && applied.delivery) {
      const { sendAgentMessage } = await import('../agent/turn/AgentTurnService')
      const result = await sendAgentMessage({ sessionId, trustedLearningDelivery: applied.delivery }, deps)
      if (!result.accepted) throw new Error('教练未接纳本轮请求，已保存的内容可继续')
    }
    return applied
  } finally {
    admittedSessions.delete(sessionId)
  }
}

export async function markLearningDeliveryComplete(progress: LearningProgress, commandId: string): Promise<void> {
  await progress.markOutboxDelivered(commandId)
}
