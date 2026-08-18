import { statSync } from 'fs'
import { resolve, sep } from 'path'
import { computeFingerprint } from '../FtsQueryBuilder'

export interface MemorySourceStat {
  size: number
  mtimeMs: number
}

export type MemorySourceStatFn = (absolutePath: string) => MemorySourceStat
export type MemorySourceFingerprintFn = (workspaceRoot: string, sourcePath: string) => string | null

export function computeMemorySourceFingerprint(
  workspaceRoot: string,
  sourcePath: string,
  stat: MemorySourceStatFn = defaultMemorySourceStat
): string | null {
  const absolutePath = resolveMemorySourcePath(workspaceRoot, sourcePath)
  if (absolutePath === null) {
    return null
  }
  try {
    const file = stat(absolutePath)
    return fingerprintMemorySourceStat(file)
  } catch {
    return null
  }
}

export function fingerprintMemorySourceStat(stat: MemorySourceStat): string {
  return computeFingerprint(stat.size, Math.floor(stat.mtimeMs))
}

export function defaultMemorySourceStat(absolutePath: string): MemorySourceStat {
  const stat = statSync(absolutePath)
  return { size: stat.size, mtimeMs: stat.mtimeMs }
}

/** sourcePath 只允许是工作区内的相对路径；越界视为无法验证 */
export function resolveMemorySourcePath(workspaceRoot: string, sourcePath: string): string | null {
  const normalized = sourcePath.replace(/\\/g, '/')
  if (
    normalized.length === 0 ||
    normalized.startsWith('/') ||
    /^[a-zA-Z]:/.test(normalized) ||
    normalized.split('/').some((segment) => segment === '..')
  ) {
    return null
  }
  const absRoot = resolve(workspaceRoot)
  const absTarget = resolve(absRoot, ...normalized.split('/'))
  const rootPrefix = absRoot.endsWith(sep) ? absRoot : absRoot + sep
  if (
    absTarget.toLowerCase() !== absRoot.toLowerCase() &&
    !absTarget.toLowerCase().startsWith(rootPrefix.toLowerCase())
  ) {
    return null
  }
  return absTarget
}
