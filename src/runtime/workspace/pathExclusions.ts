/**
 * 工作区文件发现的共享排除规则。
 * 硬排除用于依赖、构建和缓存目录，项目自身规则由根目录 `.gitignore` 补充。
 */
import { readFile as readFileAsync } from 'fs/promises'
import { join } from 'path'

// @ts-expect-error - picomatch is a transitive dep without @types/picomatch
import picomatch from 'picomatch'

/** 任何工作区扫描都不得递归进入的依赖、构建、版本控制和缓存目录。 */
export const BUILD_SKIP_DIRS: ReadonlySet<string> = new Set([
  // 依赖目录
  'node_modules', 'bower_components', '.pnpm-store', 'vendor',
  // VCS
  '.git', '.svn', '.hg', '.bzr', '.jj',
  // JVM / .NET 构建产物
  'target', 'bin', 'obj', '.gradle', '.mvn',
  // JS 框架构建产物
  'dist', 'build', 'out', '.next', '.nuxt', '.output', '.turbo', '.parcel-cache',
  // Python 缓存
  '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache',
  // 测试覆盖率 / 通用缓存
  'coverage', '.nyc_output', '.cache', '.nova'
])

/** `relPath` 相对于工作区根，并统一使用 `/`。 */
export type IgnoreMatcher = (relPath: string, isDir: boolean) => boolean

/**
 * 判断单个目录项是否命中硬排除或隐藏路径。
 * 单层目录展示可以显示被排除的目录，但递归扫描不得进入。
 */
export function isPathSkipped(name: string): boolean {
  if (!name) return false
  if (name.startsWith('.')) return true
  return BUILD_SKIP_DIRS.has(name)
}

/**
 * 加载工作区根目录的 `.gitignore`。
 * - `!pattern` 是取反模式，会覆盖之前的 ignore 判定
 * - 目录模式（如 `dist/`）会通过祖先继承作用于其下所有文件
 * - 文件不存在、不可读或模式非法时 fail open
 */
export async function loadIgnoreMatcher(workspaceRoot: string): Promise<IgnoreMatcher> {
  interface CompiledRule {
    negated: boolean
    match: (candidate: string) => boolean
  }
  const rules: CompiledRule[] = []

  let content: string
  try {
    content = await readFileAsync(join(workspaceRoot, '.gitignore'), 'utf-8')
  } catch {
    return () => false
  }

  for (const rawLine of content.split(/\r?\n/)) {
    const trimmed = rawLine.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    const negated = trimmed.startsWith('!')
    const body = negated ? trimmed.slice(1).trim() : trimmed
    const cleaned = body.endsWith('/') ? body.slice(0, -1) : body
    if (!cleaned) continue

    try {
      const matcher = picomatch(cleaned, { dot: true })
      rules.push({ negated, match: (candidate) => matcher(candidate) })
    } catch {
      // 单条非法规则不能阻断工作区扫描。
    }
  }

  if (rules.length === 0) return () => false

  return (relPath: string, _isDir: boolean): boolean => {
    if (!relPath) return false
    // 同时匹配祖先目录，使目录规则覆盖整棵子树。
    const parts = relPath.split('/')
    const candidates: string[] = []
    for (let i = 1; i <= parts.length; i++) {
      candidates.push(parts.slice(0, i).join('/'))
    }

    let ignored = false
    for (const rule of rules) {
      for (const candidate of candidates) {
        if (rule.match(candidate)) {
          ignored = !rule.negated
          break
        }
      }
    }
    return ignored
  }
}
