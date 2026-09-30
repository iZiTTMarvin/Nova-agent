import type { LearningCommand, LearningCommandReceipt } from '../../shared/learning/command'
import type { LearningProgress } from '../../runtime/learning/progress/LearningProgress'
import type { SendAgentMessageDeps } from '../agent/turn/AgentTurnService'
import { isSessionTurnInProgress } from '../agent/state'
import { resolveLearningDelivery, type LearningDeliveryPorts } from './LearningDelivery'

const admittedSessions = new Set<string>()

export interface LearningHostTurnDelivery {
  readonly userMessageId: string
  readonly commandId: string
  readonly displayText: string
  readonly modelInput: string
}

export async function applyLearningCommand(
  progress: LearningProgress,
  workspaceRoot: string,
  command: LearningCommand,
  ports: LearningDeliveryPorts
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
  const text = await resolveLearningDelivery(outbox.payload_json, ports)
  return { receipt, delivery: {
    userMessageId: outbox.user_message_id,
    commandId: outbox.command_id,
    displayText: text.displayText,
    modelInput: text.modelInput
  } }
}

export async function submitLearningCommandTurn(
  progress: LearningProgress,
  workspaceRoot: string,
  command: LearningCommand,
  ports: LearningDeliveryPorts,
  deps: SendAgentMessageDeps
): Promise<Awaited<ReturnType<typeof applyLearningCommand>>> {
  const sessionId = command.sessionId
  // 覆盖落库到 run 建立前的异步窗口；所有学习命令只从这个入口接纳。
  if (admittedSessions.has(sessionId) || isSessionTurnInProgress(sessionId)) {
    return { receipt: { ok: false, code: 'busy', message: '上一条还在回答，等它结束或先停止' }, delivery: null }
  }
  admittedSessions.add(sessionId)
  try {
    const applied = await applyLearningCommand(progress, workspaceRoot, command, ports)
    if (applied.receipt.ok && applied.delivery) {
      const { sendAgentMessage } = await import('../agent/turn/AgentTurnService')
      const result = await sendAgentMessage({ sessionId, trustedLearningDelivery: applied.delivery }, deps)
      if (!result.accepted) throw new Error('这次没能开始回答，内容已保存，可以重试')
    }
    return applied
  } finally {
    admittedSessions.delete(sessionId)
  }
}

export async function markLearningDeliveryComplete(progress: LearningProgress, commandId: string): Promise<void> {
  await progress.markOutboxDelivered(commandId)
}
