/**
 * Agent 事件会话归属门控
 *
 * 用户切走会话后，旧会话仍在主进程生成的流式事件不应污染当前 UI，
 * 也不应触发 message_end 的排队消息 drain。
 */
import { useChatStore } from '../stores/useChatStore'

/** 终态事件：即使被过滤也要清理 activeAgentSessionId */
const TERMINAL_KINDS = new Set(['message-end', 'error'])

/**
 * 判断当前是否应处理来自 activeAgentSessionId 的 Agent 事件。
 * @param kind 事件种类（用于终态清理）
 */
export function shouldHandleAgentEvent(kind: string): boolean {
  const { currentSessionId, activeAgentSessionId } = useChatStore.getState()

  if (TERMINAL_KINDS.has(kind) && activeAgentSessionId) {
  // 终态到达时若已切走，清理归属标记（不 drain 排队消息）
    if (activeAgentSessionId !== currentSessionId) {
      useChatStore.setState({
        activeAgentSessionId: null,
        isGenerating: false,
        currentGeneratingMessageId: null
      })
      return false
    }
  }

  if (!activeAgentSessionId) return true
  return activeAgentSessionId === currentSessionId
}

/** 包装 Agent 事件 handler：不属于当前会话则丢弃 */
export function gateAgentEvent<T extends unknown[]>(
  kind: string,
  handler: (...args: T) => void
): (...args: T) => void {
  return (...args: T) => {
    if (!shouldHandleAgentEvent(kind)) return
    handler(...args)
  }
}
