/**
 * TurnProcessTree 专用 store selector：等待用户输入时强制展开 L1。
 * 对齐 ChatPanel isPausedForUserInput + pausedMessageId 判定。
 */
import type { AgentState } from '../../stores/useAgentStore'

/**
 * 仅当本条 live 消息正在等待用户输入时返回 true；否则恒 false。
 * askQuestion / compose askUser 无 messageId 时，以 isLive 锚定当前生成消息。
 */
export function selectForceExpandedForMessage(
  state: AgentState,
  messageId: string,
  isLive: boolean
): boolean {
  if (!isLive) return false

  const perm = state.pendingPermissionRequest
  if (perm?.messageId === messageId) return true

  // askQuestion IPC payload 无 messageId；挂起时仅当前生成中的消息需强制展开
  if (state.pendingAskQuestion) return true

  return false
}
