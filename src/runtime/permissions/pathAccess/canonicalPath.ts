import { existsSync, realpathSync } from 'fs'
import { dirname, isAbsolute, join, normalize, relative, resolve } from 'path'

export type CanonicalResult =
  | { ok: true; path: string }
  | { ok: false; reason: string }

/**
 * 同一次工具调用内缓存目录的 canonical 结果，避免 grep/find 对每个文件重复 realpath。
 */
export class CanonicalPathCache {
  private readonly dirs = new Map<string, CanonicalResult>()

  get(lexicalDir: string): CanonicalResult | undefined {
    return this.dirs.get(lexicalDir)
  }

  set(lexicalDir: string, result: CanonicalResult): void {
    this.dirs.set(lexicalDir, result)
  }
}

export function createCanonicalPathCache(): CanonicalPathCache {
  return new CanonicalPathCache()
}

/** Windows 盘符大小写统一，避免 C: 与 c: 被当成不同根。 */
export function normalizeDrive(inputPath: string): string {
  if (process.platform === 'win32' && /^[a-zA-Z]:/.test(inputPath)) {
    return inputPath.charAt(0).toUpperCase() + inputPath.slice(1)
  }
  return inputPath
}

export function lexicalNormalize(inputPath: string): string {
  return normalizeDrive(normalize(resolve(inputPath)))
}

/**
 * 词法/canonical 路径是否落在 root 之内（含根自身）。
 * 跨盘符时 path.relative 返回绝对路径，必须按越界处理。
 */
export function isPathWithinRoot(root: string, target: string): boolean {
  const normalizedRoot = lexicalNormalize(root)
  const normalizedTarget = lexicalNormalize(target)
  const rel = relative(normalizedRoot, normalizedTarget)
  if (rel === '') return true
  if (isAbsolute(rel)) return false
  return !rel.startsWith('..')
}

/** 用 canonical 身份计算工作区相对路径，避免 Windows 短路径与 realpath 长路径互相逃逸。 */
export function toWorkspaceRelativePath(
  workspaceRoot: string,
  targetPath: string,
  cache?: CanonicalPathCache
): string | null {
  const rootCanon = canonicalizeTargetPath(workspaceRoot, cache)
  const targetCanon = canonicalizeTargetPath(targetPath, cache)
  if (!rootCanon.ok || !targetCanon.ok) return null
  if (!isPathWithinRoot(rootCanon.path, targetCanon.path)) return null
  const rel = relative(rootCanon.path, targetCanon.path)
  if (rel === '') return '.'
  if (isAbsolute(rel) || rel.startsWith('..')) return null
  return rel.replace(/\\/g, '/')
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  )
}

function realpathNative(inputPath: string): string {
  return normalizeDrive(normalize(realpathSync.native(inputPath)))
}

/** 已存在路径走 realpath，解析 symlink / junction。 */
export function canonicalizeExistingPath(
  inputPath: string,
  cache?: CanonicalPathCache
): CanonicalResult {
  const resolved = lexicalNormalize(inputPath)
  const cached = cache?.get(resolved)
  if (cached) return cached
  try {
    const result: CanonicalResult = { ok: true, path: realpathNative(resolved) }
    cache?.set(resolved, result)
    cache?.set(result.path, result)
    return result
  } catch (error) {
    const reason = isMissingPathError(error)
      ? `路径不存在: ${inputPath}`
      : `路径无法解析: ${inputPath}`
    const result: CanonicalResult = { ok: false, reason }
    cache?.set(resolved, result)
    return result
  }
}

/**
 * 目标路径（含尚未创建的文件）：对最近存在的父目录做 realpath，再拼回剩余段。
 * 整条链都不存在时退回词法路径，供测试和不落盘的根使用。
 */
export function canonicalizeTargetPath(
  inputPath: string,
  cache?: CanonicalPathCache
): CanonicalResult {
  const resolved = lexicalNormalize(inputPath)
  if (existsSync(resolved)) {
    return canonicalizeExistingPath(resolved, cache)
  }

  let current = resolved
  while (true) {
    const parent = dirname(current)
    if (parent === current) {
      return { ok: true, path: resolved }
    }
    if (existsSync(parent)) {
      const parentCanon = canonicalizeExistingPath(parent, cache)
      if (!parentCanon.ok) return parentCanon
      const rest = relative(parent, resolved)
      return { ok: true, path: normalizeDrive(normalize(join(parentCanon.path, rest))) }
    }
    current = parent
  }
}

export async function canonicalizeExistingPathAsync(
  inputPath: string,
  cache?: CanonicalPathCache
): Promise<CanonicalResult> {
  return canonicalizeExistingPath(inputPath, cache)
}
