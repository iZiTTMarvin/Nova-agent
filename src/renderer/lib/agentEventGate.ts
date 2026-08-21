/**
 * Agent 事件会话归属门控
 *
 * 多 turn 并发后，不同会话的流式事件同时到达 renderer。本门控决定哪些事件进入当前视图：
 * - 焦点会话事件：进入当前视图（现有路径）。
 * - 非焦点会话事件：第一阶段不渲染到当前视图（消息已由主进程持久化，
 *   切回去 load-session 能拉到），仅靠 RunSnapshot 驱动侧边栏徽标。
 * - 例外：权限请求是对话可用性的关键交互，子代理（后代会话）的请求必须放行到
 *   父会话视图，否则用户永远看不到请求、子运行只能干等。
 *
 * 事件 payload 现带 sessionId；无 sessionId 时回退到旧逻辑（activeAgentSessionId 兜底），
 * 保证漏注入只是「事件显示在焦点会话」，不破坏数据。
 */
import { useChatStore } from '../stores/useChatStore'

/** 允许从当前会话视图穿透的后代会话事件种类（目前仅权限请求） */
const DESCENDANT_ALLOWED_KINDS = new Set(['permission-request'])

/**
 * 判断 childSessionId 是否 currentSessionId 的（非自身的）后代会话。
 * 依据聊天会话列表里的子代理血缘（subagent.lineage.parentSessionId）向上回溯；
 * 列表缺失时返回 false（不误放行）。
 */
export function isDescendantSessionOf(childSessionId: string, ancestorSessionId: string): boolean {
  if (!childSessionId || !ancestorSessionId || childSessionId === ancestorSessionId) return false
  const { sessions } = useChatStore.getState()
  const parentByChild = new Map<string, string>()
  for (const session of sessions) {
    if (session.kind === 'subagent') {
      parentByChild.set(session.id, session.subagent.lineage.parentSessionId)
    }
  }
  let current = childSessionId
  const visited = new Set<string>()
  while (current && !visited.has(current)) {
    visited.add(current)
    if (current === ancestorSessionId) return true
    current = parentByChild.get(current) ?? ''
  }
  return false
}

/** 会话归属判定 + 后代权限请求放行；parentSessionId 为事件直父归属（快速路径） */
function allowedBySession(kind: string, eventSessionId: string | undefined, parentSessionId: string | undefined): boolean {
  const { currentSessionId, activeAgentSessionId } = useChatStore.getState()

  // 优先用事件自带的 sessionId 判定归属
  const belongsToCurrent = eventSessionId
    ? eventSessionId === currentSessionId
    : !activeAgentSessionId || activeAgentSessionId === currentSessionId

  if (belongsToCurrent) return true

  // 子代理权限请求：放行到父会话视图。直父归属由主进程随事件下发，
  // 不依赖 renderer 侧会话列表时序；更深的层级用血缘回溯兜底。
  if (DESCENDANT_ALLOWED_KINDS.has(kind) && eventSessionId && currentSessionId) {
    if (parentSessionId === currentSessionId) return true
    return isDescendantSessionOf(eventSessionId, currentSessionId)
  }

  return false
}

/**
 * 判断当前是否应处理 Agent 事件。
 *
 * @param kind 事件种类（用于终态清理）
 * @param eventSessionId 事件携带的归属会话 id（无则回退 activeAgentSessionId 兜底）
 * @param parentSessionId 子代理事件的直接父会话归属（非子代理事件不传）
 */
export function shouldHandleAgentEvent(
  kind: string,
  eventSessionId?: string,
  parentSessionId?: string
): boolean {
  const { activeAgentSessionId } = useChatStore.getState()
  if (!activeAgentSessionId && !eventSessionId) return true
  return allowedBySession(kind, eventSessionId, parentSessionId)
}

/** 包装 Agent 事件 handler：不属于当前会话则跳过当前视图渲染 */
export function gateAgentEvent<T extends unknown[]>(
  kind: string,
  handler: (...args: T) => void
): (...args: T) => void {
  return (...args: T) => {
    // 约定：事件 payload 的第一个参数是 data 对象，可能含 sessionId / parentSessionId
    const data = args[0] as { sessionId?: string; parentSessionId?: string } | undefined
    const eventSessionId = data && typeof data === 'object' ? data.sessionId : undefined
    const parentSessionId = data && typeof data === 'object' ? data.parentSessionId : undefined
    if (!shouldHandleAgentEvent(kind, eventSessionId, parentSessionId)) return
    handler(...args)
  }
}
