/**
 * Composer 工作区 chip 的纯展示逻辑：路径末段标签、项目列表派生与搜索。
 *
 * 项目列表直接由会话派生（与侧边栏同源），不新增「最近项目」持久化；
 * 默认工作区从列表排除，由菜单底部固定入口承载。
 */
import type { Session } from '../../../shared/session/types'

export interface WorkspaceProjectEntry {
  path: string
  /** 该项目最近一次使用时间，用于排序（越大越近） */
  updatedAt: number
}

function pathBasename(pathStr: string): string {
  const parts = pathStr.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] || pathStr
}

/** chip 与列表项标签：默认工作区显示固定名，其余取路径末段（与侧边栏分组同名规则一致） */
export function workspaceLabel(path: string, defaultWorkspacePath: string): string {
  if (defaultWorkspacePath && path === defaultWorkspacePath) return 'Nova 工作区'
  return pathBasename(path)
}

/** 从会话列表派生去重项目（排除默认工作区），按最近使用时间降序 */
export function listWorkspaceProjects(
  sessions: readonly Session[],
  defaultWorkspacePath: string
): WorkspaceProjectEntry[] {
  const latestByPath = new Map<string, number>()
  for (const session of sessions) {
    const path = session.workspaceRoot
    if (!path) continue
    if (defaultWorkspacePath && path === defaultWorkspacePath) continue
    const current = latestByPath.get(path)
    if (current === undefined || session.updatedAt > current) {
      latestByPath.set(path, session.updatedAt)
    }
  }

  return [...latestByPath.entries()]
    .map(([path, updatedAt]) => ({ path, updatedAt }))
    .sort((left, right) => right.updatedAt - left.updatedAt)
}

/** 搜索过滤：完整路径或路径末段命中即可；空查询返回全部 */
export function filterWorkspaceProjects(
  projects: readonly WorkspaceProjectEntry[],
  query: string
): WorkspaceProjectEntry[] {
  const normalized = query.trim().toLocaleLowerCase()
  if (normalized.length === 0) return [...projects]
  return projects.filter(project => {
    const path = project.path.toLocaleLowerCase()
    return path.includes(normalized) || pathBasename(project.path).toLocaleLowerCase().includes(normalized)
  })
}
