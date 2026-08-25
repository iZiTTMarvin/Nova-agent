import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { canonicalizeExistingPath, lexicalNormalize } from '../permissions/pathAccess'

const WORKSPACE_ID_LENGTH = 16

/** 工作区身份以规范真实路径为唯一输入，不受会话或设置影响。 */
export function normalizeCodeGraphWorkspaceRoot(workspaceRoot: string): string {
  const resolved = lexicalNormalize(workspaceRoot)
  const canonical = canonicalizeExistingPath(resolved)
  return canonical.ok ? canonical.path : resolved
}

export function computeCodeGraphWorkspaceIdentity(workspaceRoot: string): string {
  return createHash('sha256')
    .update(normalizeCodeGraphWorkspaceRoot(workspaceRoot))
    .digest('hex')
    .slice(0, WORKSPACE_ID_LENGTH)
}

export function getCodeGraphRoot(userDataPath: string): string {
  return join(userDataPath, 'code-graph')
}

export function getCodeGraphWorkspaceDir(userDataPath: string, workspaceIdentity: string): string {
  return join(getCodeGraphRoot(userDataPath), workspaceIdentity)
}

export function getCodeGraphDbPath(userDataPath: string, workspaceIdentity: string): string {
  return join(getCodeGraphWorkspaceDir(userDataPath, workspaceIdentity), 'index.db')
}
