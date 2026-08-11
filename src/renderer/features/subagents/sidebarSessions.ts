import type { PrimarySession, Session } from '../../../shared/session/types'

/** 侧栏只展示用户级会话；子代理数据仍留在 store，经消息流活动行呈现。 */
export function listSidebarRootSessions(sessions: readonly Session[]): PrimarySession[] {
  return sessions.filter((session): session is PrimarySession => session.kind === 'primary')
}

/**
 * 置顶分区投影：用户级会话中 pinned 的子集。
 * 顺序沿用 store 列表（主进程已按 updatedAt 降序），置顶不单独再排序。
 */
export function listPinnedSessions(sessions: readonly Session[]): PrimarySession[] {
  return listSidebarRootSessions(sessions).filter(session => session.pinned === true)
}

/**
 * 当前焦点若是子代理会话，侧栏高亮其父会话，避免「仅改展示」后选中态丢失。
 */
export function resolveSidebarActiveSessionId(
  sessions: readonly Session[],
  currentSessionId: string | null
): string | null {
  if (!currentSessionId) return null
  const current = sessions.find((session) => session.id === currentSessionId)
  if (current?.kind === 'subagent') {
    return current.subagent.lineage.parentSessionId
  }
  return currentSessionId
}
