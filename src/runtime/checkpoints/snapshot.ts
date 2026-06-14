/**
 * 工作区快照工具
 *
 * bash 命令执行前对工作区做内容快照，执行后对比发现变更，
 * 让 bash 造成的文件修改也能进入 checkpoint/diff 流。
 *
 * 设计取舍：
 * - 大目录继续跳过，避免把 node_modules / dist 整体扫进来
 * - 不再按文件大小忽略内容快照。只要文件在工作区边界内，
 *   就应该被审查和回退能力覆盖；否则会出现“bash 改了但 UI 看不到”的漏洞。
 * - content 用 Buffer 而非 string 存储，二进制安全（修复 utf-8 强制解码损坏 PNG / 字体等）
 * - 超过 MAX_SNAPSHOT_FILE_SIZE 的文件不读 content，只记 mtime，避免内存爆炸
 */
import { readdirSync, statSync, readFileSync } from 'fs'
import { join, relative } from 'path'

/** 跳过的目录名 */
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out',
  '__pycache__', '.next', 'target', '.cache', '.nova'
])

/**
 * 单文件内容快照大小上限。
 * 超过该值的文件只记 mtime（用于检测变化），不读 content 到内存：
 * - 避免巨大产物（如编译输出）一次性吃满内存
 * - 这类大文件即使被 bash 改了，按字节回退也不实际
 */
const MAX_SNAPSHOT_FILE_SIZE = 10 * 1024 * 1024  // 10MB

export interface FileSnapshot {
  /**
   * 文件字节内容（二进制安全）。
   * 超大文件（>MAX_SNAPSHOT_FILE_SIZE）跳过内容读取，content 为 undefined。
   * 这种情况下无法回退，但 mtime 仍可用于检测变化。
   */
  content?: Buffer
  mtimeMs: number
  size: number
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
        const relPath = relative(root, fullPath).replace(/\\/g, '/')
        // 超大文件：只记 mtime 不读 content，避免内存爆炸
        if (stat.size > MAX_SNAPSHOT_FILE_SIZE) {
          snapshot.set(relPath, { mtimeMs: stat.mtimeMs, size: stat.size })
          continue
        }
        // 用 Buffer 读，二进制安全（修复 utf-8 强制解码损坏）
        const content = readFileSync(fullPath)
        snapshot.set(relPath, { content, mtimeMs: stat.mtimeMs, size: stat.size })
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
        const relPath = relative(root, fullPath).replace(/\\/g, '/')
        mtimes.set(relPath, stat.mtimeMs)
      } catch { continue }
    }
  }
}
