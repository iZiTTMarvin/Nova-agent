/**
 * 通用记忆的会话排除策略（唯一事实源）。
 * learn 会话不进入通用记忆体系：工具轨迹采集、episodic 落盘、提炼计数与
 * memory_* 工具面全部排除，防止学习内容污染主开发记忆。
 */
import { isMemoryExcludedSessionState } from '../../runtime/memory/MemorySessionExclusion'
export { isMemoryExcludedMode } from '../../runtime/memory/MemorySessionExclusion'
import { getSessionStore } from './SessionStoreHost'

/**
 * 按会话元数据判定。SessionStore 未初始化只出现在无会话上下文的
 * 测试/评测装配中，那里不存在 learn 会话，按不排除处理。
 */
export function isMemoryExcludedSession(sessionId: string): boolean {
  try {
    const session = getSessionStore().loadMetadata(sessionId)
    return session ? isMemoryExcludedSessionState(session) : false
  } catch {
    return false
  }
}
