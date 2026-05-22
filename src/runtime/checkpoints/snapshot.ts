/**
 * 工作区快照工具
 *
 * bash 命令执行前对工作区做内容快照，执行后对比发现变更，
 * 让 bash 造成的文件修改也能进入 checkpoint/diff 流。
 */
import { readdirSync, statSync, readFileSync, existsSync } from 'fs'
import { join, relative } from 'path'

/** 跳过的目录名 */
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out',
  '__pycache__', '.next', 'target', '.cache', '.nova'
])

/** 单个文件的上限大小，超过则跳过（避免读大文件） */
const MAX_FILE_SIZE = 100 * 1024

export interface FileSnapshot {
  content: string
  mtimeMs: number
}

/** 工作区快照：相对路径 → 文件内容 + mtime */
export type WorkspaceSnapshot = Map<string, FileSnapshot>

/**
 * 遍历工作区，读取所有源文件的当前内容和 mtime
 * 跳过大文件、二进制目录和隐藏目录
 */
export function snapshotWorkspace(workspaceRoot: string): WorkspaceSnapshot {
  const snapshot: WorkspaceSnapshot = new Map()
  walk(workspaceRoot, workspaceRoot, snapshot)
  return snapshot
}

/** 仅采集 mtime 的轻量快照，用于执行后对比 */
export type MtimeSnapshot = Map<string, number>

export function snapshotMtimes(workspaceRoot: string): MtimeSnapshot {
  const mtimes: MtimeSnapshot = new Map()
  walkMtimes(workspaceRoot, workspaceRoot, mtimes)
  return mtimes
}

/** 对比执行前后的快照，找出新增/修改/删除的文件 */
export function diffSnapshots(
  before: WorkspaceSnapshot,
  after: MtimeSnapshot
): { modified: string[]; added: string[]; deleted: string[] } {
  const modified: string[] = []
  const added: string[] = []
  const deleted: string[] = []

  for (const [path, entry] of before) {
    const afterMtime = after.get(path)
    if (afterMtime === undefined) {
      deleted.push(path)
    } else if (afterMtime !== entry.mtimeMs) {
      modified.push(path)
    }
  }

  for (const path of after.keys()) {
    if (!before.has(path)) {
      added.push(path)
    }
  }

  return { modified, added, deleted }
}

function walk(root: string, dir: string, snapshot: WorkspaceSnapshot): void {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch { return }

  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      walk(root, fullPath, snapshot)
    } else if (entry.isFile()) {
      try {
        const stat = statSync(fullPath)
        if (stat.size > MAX_FILE_SIZE) continue
        const relPath = relative(root, fullPath).replace(/\\/g, '/')
        const content = readFileSync(fullPath, 'utf-8')
        snapshot.set(relPath, { content, mtimeMs: stat.mtimeMs })
      } catch { continue }
    }
  }
}

function walkMtimes(root: string, dir: string, mtimes: MtimeSnapshot): void {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch { return }

  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      walkMtimes(root, fullPath, mtimes)
    } else if (entry.isFile()) {
      try {
        const stat = statSync(fullPath)
        if (stat.size > MAX_FILE_SIZE) continue
        const relPath = relative(root, fullPath).replace(/\\/g, '/')
        mtimes.set(relPath, stat.mtimeMs)
      } catch { continue }
    }
  }
}
