import type { LearningCommand, LearningCommandReceipt } from '../../shared/learning/command'
import type { LearningProgress } from '../../runtime/learning/progress/LearningProgress'
import type { SendAgentMessageDeps } from '../agent/turn/AgentTurnService'

export function formatLearningTurnContent(command: LearningCommand): string | null {
  const action = command.action
  if (action.type === 'select_node') {
    return `[学习选点] 请围绕知识节点 ${action.nodeId} 讲解，并引用有效出处。`
  }
  if (action.type === 'message') {
    return action.text
  }
  return null
}

export function formatOutboxDeliverContent(payloadJson: string): string {
  const payload = JSON.parse(payloadJson) as {
    kind?: string
    text?: string
    checkpointId?: string
    attemptId?: string
  }
  if (payload.kind === 'deliver_answer') {
    return `[学习回答]\n停点: ${payload.checkpointId ?? ''}\nattempt: ${payload.attemptId ?? ''}\n${payload.text ?? ''}`
  }
  return payload.text ?? ''
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
): Promise<{
  receipt: LearningCommandReceipt
  coachTurn: string | null
  delivery: LearningHostTurnDelivery | null
}> {
  await progress.getCursor(workspaceRoot, command.sessionId)
  const receipt = await progress.applyCommand(command)
  if (receipt.ok !== true || !receipt.applied) {
    return { receipt, coachTurn: null, delivery: null }
  }
  const coachTurn = formatLearningTurnContent(command)
  const outbox = await progress.getPendingOutbox(command.sessionId)
  if (outbox) {
    return {
      receipt,
      coachTurn: null,
      delivery: {
        userMessageId: outbox.user_message_id,
        content: formatOutboxDeliverContent(outbox.payload_json),
        commandId: outbox.command_id
      }
    }
  }
  return { receipt, coachTurn, delivery: null }
}

/** 命令接纳后启动受信任教练 turn 或 outbox 交接。Renderer 不直接调用。 */
export async function submitLearningCommandTurn(
  progress: LearningProgress,
  workspaceRoot: string,
  command: LearningCommand,
  deps: SendAgentMessageDeps
): Promise<Awaited<ReturnType<typeof applyLearningCommand>>> {
  const applied = await applyLearningCommand(progress, workspaceRoot, command)
  if (applied.receipt.ok !== true || !applied.receipt.applied) return applied
  const { sendAgentMessage } = await import('../agent/turn/AgentTurnService')
  if (applied.delivery) {
    await sendAgentMessage(
      { sessionId: command.sessionId, trustedLearningDelivery: applied.delivery },
      deps
    )
  } else if (applied.coachTurn) {
    await sendAgentMessage(
      {
        sessionId: command.sessionId,
        trustedLearningTurn: { content: applied.coachTurn }
      },
      deps
    )
  }
  return applied
}

export async function markLearningDeliveryComplete(
  progress: LearningProgress,
  commandId: string
): Promise<void> {
  await progress.markOutboxDelivered(commandId)
}
