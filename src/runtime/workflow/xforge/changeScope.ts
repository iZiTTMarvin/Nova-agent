/**
 * XForge changeScope 路径匹配：写入授权与 Review Snapshot 共用同一规则。
 */

export function normalizeWorkspaceRelativePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '')
}

function normalizeScope(scope: string): string {
  return normalizeWorkspaceRelativePath(scope.trim()).replace(/\/+$/, '')
}

/** 判断工作区相对路径是否落在 validatedPlan.changeScope 内 */
export function isPathAllowedByChangeScope(
  relativePath: string,
  changeScope: readonly string[]
): boolean {
  const normalizedPath = normalizeWorkspaceRelativePath(relativePath)
  return changeScope.some(scope => {
    const normalized = normalizeScope(scope)
    if (!normalized) return false
    if (normalized === '.' || normalized === '*' || normalized === '**/*') return true
    if (normalized.endsWith('/**')) {
      const prefix = normalized.slice(0, -3)
      return normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`)
    }
    return normalizedPath === normalized || normalizedPath.startsWith(`${normalized}/`)
  })
}
