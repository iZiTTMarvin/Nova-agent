/**
 * Agent 事件会话归属门控
 *
 * 多 turn 并发后，不同会话的流式事件同时到达 renderer。本门控决定哪些事件进入当前视图：
 * - 焦点会话事件：进入当前视图（现有路径）。
 * - 非焦点会话事件：第一阶段不渲染到当前视图（消息已由主进程持久化，
 *   切回去 load-session 能拉到），仅靠 RunSnapshot 驱动侧边栏徽标。
 *
 * 事件 payload 现带 sessionId（P3）；无 sessionId 时回退到旧逻辑（activeAgentSessionId 兜底），
 * 保证漏注入只是「事件显示在焦点会话」，不破坏数据。
 */
import { useChatStore } from '../stores/useChatStore'

/** 终态事件：即使被过滤也要清理 activeAgentSessionId */
const TERMINAL_KINDS = new Set(['message-end', 'error'])

/**
 * 判断当前是否应处理 Agent 事件。
 *
 * @param kind 事件种类（用于终态清理）
 * @param eventSessionId 事件携带的归属会话 id（无则回退 activeAgentSessionId 兜底）
 */
export function shouldHandleAgentEvent(
  kind: string,
  eventSessionId?: string
): boolean {
  const { currentSessionId, activeAgentSessionId } = useChatStore.getState()

  // 优先用事件自带的 sessionId 判定归属
  const belongsToCurrent = eventSessionId
    ? eventSessionId === currentSessionId
    : !activeAgentSessionId || activeAgentSessionId === currentSessionId

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

  if (!activeAgentSessionId && !eventSessionId) return true
  return belongsToCurrent
}

/** 包装 Agent 事件 handler：不属于当前会话则跳过当前视图渲染 */
export function gateAgentEvent<T extends unknown[]>(
  kind: string,
  handler: (...args: T) => void
): (...args: T) => void {
  return (...args: T) => {
    // 约定：事件 payload 的第一个参数是 data 对象，可能含 sessionId
    const data = args[0] as { sessionId?: string } | undefined
    const eventSessionId = data && typeof data === 'object' ? data.sessionId : undefined
    if (!shouldHandleAgentEvent(kind, eventSessionId)) return
    handler(...args)
  }
}
