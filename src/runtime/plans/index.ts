import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync
} from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'

export const PLAN_RELATIVE_DIR = '.nova/plans'
const MAX_PLAN_DOCUMENT_CHARS = 1_000_000

export interface ActivePlanRef {
  /** 相对于工作区根目录，只允许 `.nova/plans/` 下的直接 Markdown 文件。 */
  path: string
  title: string
  updatedAt: number
}

export function isPlanRelativePath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\.nova\/plans\/[^/\\]+\.md$/u.test(value)
  )
}

/** 验证 active plan 仍是工作区 `.nova/plans/` 内的真实普通文件。 */
export function isReadablePlanInWorkspace(
  workspaceRoot: string,
  relativePath: unknown
): relativePath is string {
  if (!isPlanRelativePath(relativePath)) return false
  try {
    const novaDirectory = join(workspaceRoot, '.nova')
    const planDirectory = join(novaDirectory, 'plans')
    const planPath = resolve(workspaceRoot, relativePath)
    const planEntry = lstatSync(planPath)
    if (
      lstatSync(novaDirectory).isSymbolicLink() ||
      lstatSync(planDirectory).isSymbolicLink() ||
      planEntry.isSymbolicLink() ||
      !planEntry.isFile() ||
      planEntry.nlink > 1
    ) {
      return false
    }

    const realWorkspace = realpathSync(workspaceRoot)
    const realPlan = realpathSync(planPath)
    const rel = relative(realWorkspace, realPlan)
    return rel !== '' && !isAbsolute(rel) && !rel.startsWith('..')
  } catch {
    return false
  }
}

/** 读取已通过 active-plan 边界校验的 Markdown；拒绝超大或在读取前失效的文件。 */
export function readPlanDocumentInWorkspace(
  workspaceRoot: string,
  relativePath: unknown
): string | null {
  if (!isReadablePlanInWorkspace(workspaceRoot, relativePath)) return null
  const planPath = resolve(workspaceRoot, relativePath)
  let descriptor: number | null = null
  try {
    descriptor = openSync(planPath, 'r')
    const opened = fstatSync(descriptor)
    const currentPath = lstatSync(planPath)
    if (
      !opened.isFile() ||
      opened.nlink > 1 ||
      currentPath.isSymbolicLink() ||
      opened.dev !== currentPath.dev ||
      opened.ino !== currentPath.ino ||
      !isReadablePlanInWorkspace(workspaceRoot, relativePath)
    ) {
      return null
    }

    const content = readFileSync(descriptor, 'utf8')
    return content.length <= MAX_PLAN_DOCUMENT_CHARS ? content : null
  } catch {
    return null
  } finally {
    if (descriptor !== null) closeSync(descriptor)
  }
}
