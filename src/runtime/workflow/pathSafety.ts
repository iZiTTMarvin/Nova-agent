import { lstat, realpath } from 'fs/promises'
import { isAbsolute, relative, resolve } from 'path'

export interface SafeExistingPath {
  absolutePath: string
  canonicalPath: string
  stats: Awaited<ReturnType<typeof lstat>>
}

export function assertSafeRelativePath(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\.\//, '')
  if (
    !normalized ||
    normalized.includes('\0') ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized.split('/').includes('..')
  ) {
    throw new Error(`拒绝绝对/非法路径: ${relativePath}`)
  }
  return normalized
}

export function isPathInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

export async function canonicalizeRoot(root: string): Promise<string> {
  return realpath(root)
}

export async function resolveExistingPathUnderRoot(
  canonicalRoot: string,
  relativePath: string
): Promise<SafeExistingPath | null> {
  const normalized = assertSafeRelativePath(relativePath)
  const absolutePath = resolve(canonicalRoot, normalized)
  if (!isPathInside(canonicalRoot, absolutePath)) {
    throw new Error(`路径逃逸工作区: ${relativePath}`)
  }

  let stats: Awaited<ReturnType<typeof lstat>>
  try {
    stats = await lstat(absolutePath)
  } catch (error) {
    if (isMissingPathError(error)) return null
    throw error
  }

  const canonicalPath = await realpath(absolutePath)
  if (!isPathInside(canonicalRoot, canonicalPath)) {
    throw new Error(`符号链接或 junction 越界: ${relativePath}`)
  }
  return { absolutePath, canonicalPath, stats }
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}
