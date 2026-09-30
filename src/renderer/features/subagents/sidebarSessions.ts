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

/**
 * 按表面过滤：开发面只显示 default/plan/compose 会话，学习面只显示 learn 会话
 * （§20.2 会话抽屉按面过滤，学习会话不混入开发列表）。
 */
export function listSidebarSessionsForSurface(
  sessions: readonly Session[],
  surface: 'dev' | 'learn'
): PrimarySession[] {
  return listSidebarRootSessions(sessions).filter(session =>
    surface === 'learn' ? session.mode === 'learn' : session.mode !== 'learn'
  )
}


/** 面包屑下拉：当前工作区、当前表面的用户级会话（学习与开发会话不混列）。 */
export function listBreadcrumbSessions(
  sessions: readonly Session[],
  workspaceRoot: string,
  surface: 'dev' | 'learn'
): PrimarySession[] {
  return listSidebarSessionsForSurface(sessions, surface).filter(session => session.workspaceRoot === workspaceRoot)
}
