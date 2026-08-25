/**
 * 当前项目只读文件浏览 IPC（Inspector「文件」tab）。
 * 列举/预览为可单测纯函数；注册路径与其它 handler 一样使用静态 import，
 * 避免打包后运行时 require 相对路径失效。
 */
import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  statSync
} from 'fs'
import { isAbsolute, resolve } from 'path'
import {
  canonicalizeExistingPath,
  canonicalizeTargetPath,
  isPathWithinRoot
} from '../../runtime/permissions/pathAccess'
import { FS_LIST_DIRECTORY, FS_READ_FILE_PREVIEW } from '../../shared/ipc/channels'
import type {
  FsEntry,
  FsListDirectoryParams,
  FsListDirectoryResult,
  FsReadFilePreviewParams,
  FsReadFilePreviewResult
} from '../../shared/fs/types'
import { getWorkspaceService } from '../services/WorkspaceService'
import { handle } from './secureIpc'

const EXCLUDED_NAMES = new Set([
  'node_modules',
  '.git',
  'dist',
  'out',
  'build',
  '.next',
  'coverage',
  '__pycache__'
])

const MAX_PREVIEW_BYTES = 512 * 1024
const BINARY_SCAN_BYTES = 8 * 1024

/** 拒绝绝对路径与 `..` 段，防止相对路径逃逸 */
function assertSafeRelative(relativePath: string): void {
  if (relativePath === '') return
  if (isAbsolute(relativePath)) {
    throw new Error('非法路径：不允许绝对路径')
  }
  // Windows 盘符相对写法（C:foo）也拒
  if (/^[a-zA-Z]:/.test(relativePath)) {
    throw new Error('非法路径：不允许绝对路径')
  }
  const segments = relativePath.replace(/\\/g, '/').split('/')
  if (segments.some((s) => s === '..')) {
    throw new Error('非法路径：不允许路径逃逸')
  }
}

function toPosixRelative(relativeDir: string, name: string): string {
  if (relativeDir === '' || relativeDir === '.') return name
  return `${relativeDir.replace(/\\/g, '/')}/${name}`
}

/**
 * resolve + realpath 双重校验：符号链接指向 root 外时拒绝。
 * 返回已解析的真实路径。
 */
export function resolvePathInsideRoot(rootAbs: string, relativePath: string): string {
  assertSafeRelative(relativePath)
  const resolved = resolve(rootAbs, relativePath)
  if (!isPathWithinRoot(rootAbs, resolved)) {
    throw new Error('非法路径：超出项目根')
  }
  const rootCanon = canonicalizeTargetPath(rootAbs)
  if (!rootCanon.ok) {
    throw new Error('路径不存在')
  }
  const realResult = canonicalizeExistingPath(resolved)
  if (!realResult.ok) {
    throw new Error('路径不存在')
  }
  if (!isPathWithinRoot(rootCanon.path, realResult.path)) {
    throw new Error('非法路径：超出项目根')
  }
  return realResult.path
}

/** 单层列举；符号链接指向 root 外时跳过该项 */
export function listDirectoryEntries(
  rootAbs: string,
  relativeDir: string
): FsListDirectoryResult {
  const dirReal = resolvePathInsideRoot(rootAbs, relativeDir)
  let names: string[]
  try {
    names = readdirSync(dirReal)
  } catch {
    throw new Error('无法读取目录')
  }

  const entries: FsEntry[] = []
  for (const name of names) {
    if (EXCLUDED_NAMES.has(name)) continue
    const entryAbs = resolve(dirReal, name)
    let type: 'file' | 'directory'
    try {
      const lst = lstatSync(entryAbs)
      if (lst.isSymbolicLink()) {
        const linkCanon = canonicalizeExistingPath(entryAbs)
        if (!linkCanon.ok) continue
        if (!isPathWithinRoot(dirReal, linkCanon.path)) continue
        const targetStat = statSync(linkCanon.path)
        if (targetStat.isDirectory()) type = 'directory'
        else if (targetStat.isFile()) type = 'file'
        else continue
      } else if (lst.isDirectory()) {
        type = 'directory'
      } else if (lst.isFile()) {
        type = 'file'
      } else {
        continue
      }
    } catch {
      continue
    }
    entries.push({
      name,
      relativePath: toPosixRelative(relativeDir, name),
      type
    })
  }

  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
    return a.name.localeCompare(b.name)
  })

  return { entries }
}

/** utf8 预览；>512KB 截断；前 8KB 含 NUL 视为二进制 */
export function readFilePreview(
  rootAbs: string,
  relativePath: string
): FsReadFilePreviewResult {
  if (relativePath === '') {
    throw new Error('非法路径：缺少文件路径')
  }
  const real = resolvePathInsideRoot(rootAbs, relativePath)
  const fd = openSync(real, 'r')
  try {
    const size = fstatSync(fd).size
    const toRead = Math.min(size, MAX_PREVIEW_BYTES)
    const buf = Buffer.alloc(toRead)
    if (toRead > 0) {
      readSync(fd, buf, 0, toRead, 0)
    }
    const scanLen = Math.min(buf.length, BINARY_SCAN_BYTES)
    for (let i = 0; i < scanLen; i++) {
      if (buf[i] === 0) {
        return { content: '', truncated: false, binary: true }
      }
    }
    return {
      content: buf.toString('utf8'),
      truncated: size > MAX_PREVIEW_BYTES,
      binary: false
    }
  } finally {
    closeSync(fd)
  }
}

function requireProjectRoot(): string {
  const root = getWorkspaceService().getState().currentProjectPath
  if (!root?.trim()) {
    throw new Error('尚未选择项目')
  }
  return root
}

export function registerFsHandler(): void {
  handle(
    FS_LIST_DIRECTORY,
    async (_event, params: FsListDirectoryParams): Promise<FsListDirectoryResult> => {
      const root = requireProjectRoot()
      return listDirectoryEntries(root, params?.relativeDir ?? '')
    }
  )

  handle(
    FS_READ_FILE_PREVIEW,
    async (_event, params: FsReadFilePreviewParams): Promise<FsReadFilePreviewResult> => {
      const root = requireProjectRoot()
      return readFilePreview(root, params.relativePath)
    }
  )
}
