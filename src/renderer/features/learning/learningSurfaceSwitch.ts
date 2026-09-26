/**
 * 学习表面切换：开发 ↔ 学习
 *
 * 会话焦点唯一 Owner 仍是主进程 Workspace；这里只做「选哪个会话」的决策与转发。
 * 学习会话不原地切换开发会话模式：进入学习是选择/新建 learn 会话，
 * 返回开发是选择原开发会话（Renderer 记住各表面最近会话偏好，不是焦点事实源）。
 */
import type { Session } from '../../../shared/session/types'
import { isDevelopmentMode } from '../../../shared/session/mode'
import { useWorkspaceStore } from '../../stores/useWorkspaceStore'
import { useLearningStore } from './useLearningStore'

const LAST_DEV_SESSION_KEY = 'nova.learning.lastDevSession'

function canUseLocalStorage(): boolean {
  return typeof localStorage !== 'undefined'
}

export function rememberLastDevSession(projectPath: string, sessionId: string): void {
  if (!canUseLocalStorage()) return
  try {
    const raw = localStorage.getItem(LAST_DEV_SESSION_KEY)
    const map = raw ? (JSON.parse(raw) as Record<string, string>) : {}
    map[projectPath] = sessionId
    localStorage.setItem(LAST_DEV_SESSION_KEY, JSON.stringify(map))
  } catch {
    // 配额或隐私模式：忽略，仍按最近开发会话回落
  }
}

export function readLastDevSession(projectPath: string): string | null {
  if (!canUseLocalStorage()) return null
  try {
    const raw = localStorage.getItem(LAST_DEV_SESSION_KEY)
    if (!raw) return null
    const map = JSON.parse(raw) as Record<string, string>
    const sessionId = map[projectPath]
    return typeof sessionId === 'string' && sessionId ? sessionId : null
  } catch {
    return null
  }
}

export function isLearnSession(session: Session): boolean {
  return session.mode === 'learn' && session.kind === 'primary'
}

export function findLearnSessionForProject(
  sessions: readonly Session[],
  projectPath: string | null
): Session | null {
  if (!projectPath) return null
  const candidates = sessions.filter(
    session => isLearnSession(session) && session.workspaceRoot === projectPath
  )
  if (candidates.length === 0) return null
  return candidates.reduce((latest, session) => (session.updatedAt > latest.updatedAt ? session : latest))
}

export function findDevSessionForProject(
  sessions: readonly Session[],
  projectPath: string | null,
  preferSessionId?: string | null
): Session | null {
  if (!projectPath) return null
  const candidates = sessions.filter(
    session =>
      session.kind === 'primary' &&
      isDevelopmentMode(session.mode) &&
      session.workspaceRoot === projectPath
  )
  const preferred = preferSessionId ? candidates.find(session => session.id === preferSessionId) : undefined
  if (preferred) return preferred
  if (candidates.length === 0) return null
  return candidates.reduce((latest, session) => (session.updatedAt > latest.updatedAt ? session : latest))
}

/** 进入学习表面：记住原开发会话，选择或新建本项目 learn 会话。 */
export async function switchToLearningSurface(): Promise<void> {
  const workspace = useWorkspaceStore.getState()
  const projectPath = workspace.currentProjectPath
  if (!projectPath) return
  if (workspace.currentMode === 'learn') return
  if (workspace.currentSessionId) {
    rememberLastDevSession(projectPath, workspace.currentSessionId)
  }
  const existing = findLearnSessionForProject(workspace.availableSessions, projectPath)
  if (existing) {
    await workspace.selectSession(existing.id)
  } else {
    await workspace.createSession(projectPath, 'learn')
  }
  const current = useWorkspaceStore.getState()
  if (current.currentMode === 'learn') useLearningStore.getState().clearForSession(current.currentSessionId)
}

/** 返回开发表面：恢复原开发会话（无则选最近开发会话，再无则新建）。 */
export async function switchToDevSurface(): Promise<void> {
  const workspace = useWorkspaceStore.getState()
  const projectPath = workspace.currentProjectPath
  if (!projectPath) return
  if (isDevelopmentMode(workspace.currentMode)) return
  const preferred = readLastDevSession(projectPath)
  const existing = findDevSessionForProject(workspace.availableSessions, projectPath, preferred)
  if (existing) {
    await workspace.selectSession(existing.id)
    return
  }
  await workspace.createSession(projectPath, 'default')
}

export function activeSurfaceOfMode(mode: string): 'dev' | 'learn' {
  return mode === 'learn' ? 'learn' : 'dev'
}
