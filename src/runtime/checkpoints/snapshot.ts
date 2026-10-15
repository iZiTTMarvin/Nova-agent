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
 * - 已异步化（fs/promises），每层 await 让出事件循环，避免 Electron 主进程假死
 * - 已接入 pathExclusions 排除清单和 .gitignore 二次过滤
 * - 已增加文件数 / 总字节预算保护，超预算时降级为 mtime-only
 * - 执行前快照可被取消（取消后整体标记为未知）；执行后快照必须完整，不响应取消
 * - 读取失败但非"不存在"的路径记为未知，diff 不据此推断新增或删除
 */
import { readdir, stat, readFile } from 'fs/promises'
import { join, relative } from 'path'
import { isPathSkipped, loadIgnoreMatcher, type IgnoreMatcher } from '../workspace'

// ── 诊断打点（2026-06-25 卡顿定位）──────────────────────────────
// 默认完全 no-op，仅当环境变量 NOVA_SNAPSHOT_DEBUG=1 时输出耗时统计到主进程终端。
// 用 console.warn 确保输出不被 Vite/electron-vite 的日志层吞掉。
const SNAPSHOT_DEBUG = process.env.NOVA_SNAPSHOT_DEBUG === '1'

interface SnapshotStats {
  fileCount: number
  totalBytes: number
  skippedBigFiles: number
  budgetLimited: number
}

async function timedSnapshot<T extends SnapshotStats>(
  label: string,
  fn: () => Promise<T>
): Promise<T> {
  if (!SNAPSHOT_DEBUG) return fn()
  const t0 = process.hrtime.bigint()
  const stats = await fn()
  const ms = Number(process.hrtime.bigint() - t0) / 1e6
  // eslint-disable-next-line no-console
  console.warn(
    `[snapshot] ${label}: ${ms.toFixed(1)} ms | files=${stats.fileCount} ` +
    `bytes=${(stats.totalBytes / 1024 / 1024).toFixed(2)}MB ` +
    `skippedBig=${stats.skippedBigFiles} budgetLimited=${stats.budgetLimited}`
  )
  return stats
}

/** 单文件内容快照大小上限。 */
const MAX_SNAPSHOT_FILE_SIZE = 10 * 1024 * 1024  // 10MB

/** 默认文件数预算：超过后降级为 mtime-only。 */
const DEFAULT_MAX_FILES = 10_000

/** 默认总字节预算：超过后降级为 mtime-only。 */
const DEFAULT_MAX_BYTES = 500 * 1024 * 1024  // 500MB

export interface SnapshotOptions extends ScanBudget {
  /** 取消信号：命中即停止遍历，结果整体标记为未知。 */
  abortSignal?: AbortSignal
  /**
   * 是否读取文件正文。默认 true。
   * 只读命令只需 mtime/size 做变更检测；无正文的条目无法回退，走 skipped。
   */
  includeContent?: boolean
}

export interface ScanBudget {
  /** 最大处理文件数，超出后后续文件只记 mtime。 */
  maxFiles?: number
  /** 最大读取字节数（含已读 content），超出后后续文件只记 mtime。 */
  maxBytes?: number
}

export interface FileSnapshot {
  /**
   * 文件字节内容（二进制安全）。
   * 超大文件（>MAX_SNAPSHOT_FILE_SIZE）、预算耗尽或正文读取失败时为 undefined。
   * 这种情况下无法回退，但 mtime 仍可用于检测变化。
   */
  content?: Buffer
  mtimeMs: number
  size: number
}

/**
 * 读取失败（非"不存在"）的相对路径。目录项覆盖其全部后代，'' 覆盖整个工作区。
 * 这些路径的存在与否未知，diff 不能据此推断新增或删除。
 */
export type UnreadablePaths = Set<string>

/** 工作区快照：相对路径 → 文件内容 + mtime */
export interface WorkspaceSnapshot {
  files: Map<string, FileSnapshot>
  unreadable: UnreadablePaths
}

/**
 * 遍历工作区，读取所有源文件的当前内容和 mtime
 * 跳过大文件、排除目录、隐藏目录、gitignore 命中项及预算超限项
 */
export async function snapshotWorkspace(
  workspaceRoot: string,
  options: SnapshotOptions = {}
): Promise<WorkspaceSnapshot> {
  const snapshot: WorkspaceSnapshot = { files: new Map(), unreadable: new Set() }
  const stats: SnapshotStats = { fileCount: 0, totalBytes: 0, skippedBigFiles: 0, budgetLimited: 0 }
  const ignoreMatcher = await loadIgnoreMatcher(workspaceRoot)
  await timedSnapshot('snapshotWorkspace', async () => {
    await walk(workspaceRoot, workspaceRoot, snapshot, stats, options, ignoreMatcher)
    return stats
  })
  if (options.abortSignal?.aborted) snapshot.unreadable.add('')
  return snapshot
}

/** 仅采集 mtime 的轻量快照，用于执行后对比 */
export interface MtimeSnapshot {
  mtimes: Map<string, number>
  unreadable: UnreadablePaths
}

/** 执行后快照记录的是已经发生的改动，必须完整遍历，因此不接受取消信号。 */
export async function snapshotMtimes(
  workspaceRoot: string,
  budget: ScanBudget = {}
): Promise<MtimeSnapshot> {
  const snapshot: MtimeSnapshot = { mtimes: new Map(), unreadable: new Set() }
  const stats: SnapshotStats = { fileCount: 0, totalBytes: 0, skippedBigFiles: 0, budgetLimited: 0 }
  const ignoreMatcher = await loadIgnoreMatcher(workspaceRoot)
  await timedSnapshot('snapshotMtimes   ', async () => {
    await walkMtimes(workspaceRoot, workspaceRoot, snapshot, stats, budget, ignoreMatcher)
    return stats
  })
  return snapshot
}

export function isUnreadablePath(unreadable: UnreadablePaths, relPath: string): boolean {
  if (unreadable.size === 0) return false
  if (unreadable.has('')) return true
  let cut = relPath.length
  while (cut > 0) {
    if (unreadable.has(relPath.slice(0, cut))) return true
    cut = relPath.lastIndexOf('/', cut - 1)
  }
  return false
}

/** 对比执行前后的快照，找出新增/修改/删除的文件；任一侧状态未知的路径不计入 */
export function diffSnapshots(
  before: WorkspaceSnapshot,
  after: MtimeSnapshot
): { modified: string[]; added: string[]; deleted: string[] } {
  const modified: string[] = []
  const added: string[] = []
  const deleted: string[] = []

  for (const [path, entry] of before.files) {
    const afterMtime = after.mtimes.get(path)
    if (afterMtime === undefined) {
      if (!isUnreadablePath(after.unreadable, path)) deleted.push(path)
    } else if (afterMtime !== entry.mtimeMs) {
      modified.push(path)
    }
  }

  for (const path of after.mtimes.keys()) {
    if (!before.files.has(path) && !isUnreadablePath(before.unreadable, path)) {
      added.push(path)
    }
  }

  return { modified, added, deleted }
}

/**
 * 读取单个文件快照。stat 失败按"不存在 / 未知"区分；
 * 正文读取失败时退化为 mtime-only，保证已存在的文件不会因读不到正文而被当成不存在。
 */
export async function readFileSnapshot(
  fullPath: string,
  shouldReadContent: (size: number) => boolean
): Promise<FileSnapshot | 'missing' | 'unreadable'> {
  let fileStat
  try {
    fileStat = await stat(fullPath)
  } catch (error) {
    return isMissingPathError(error) ? 'missing' : 'unreadable'
  }
  const entry: FileSnapshot = { mtimeMs: fileStat.mtimeMs, size: fileStat.size }
  if (!shouldReadContent(fileStat.size)) return entry
  try {
    return { ...entry, content: await readFile(fullPath) }
  } catch (error) {
    return isMissingPathError(error) ? 'missing' : entry
  }
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  )
}

function toRelPath(root: string, fullPath: string): string {
  return relative(root, fullPath).replace(/\\/g, '/')
}

function isBudgetExceeded(stats: SnapshotStats, budget: ScanBudget): boolean {
  const maxFiles = budget.maxFiles ?? DEFAULT_MAX_FILES
  const maxBytes = budget.maxBytes ?? DEFAULT_MAX_BYTES
  return stats.fileCount > maxFiles || stats.totalBytes > maxBytes
}

async function walk(
  root: string,
  dir: string,
  snapshot: WorkspaceSnapshot,
  stats: SnapshotStats,
  options: SnapshotOptions,
  ignoreMatcher: IgnoreMatcher
): Promise<void> {
  if (options.abortSignal?.aborted) return

  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    if (!isMissingPathError(error)) snapshot.unreadable.add(toRelPath(root, dir))
    return
  }

  for (const entry of entries) {
    if (options.abortSignal?.aborted) return

    const name = entry.name
    if (isPathSkipped(name)) continue

    const fullPath = join(dir, name)
    const relPath = toRelPath(root, fullPath)

    let isDir: boolean
    try {
      // Dirent.isDirectory() 免 stat；符号链接断裂等边缘情况补一次异步 stat
      isDir = entry.isDirectory()
    } catch {
      try {
        isDir = (await stat(fullPath)).isDirectory()
      } catch (error) {
        if (!isMissingPathError(error)) snapshot.unreadable.add(relPath)
        continue
      }
    }

    if (isDir) {
      // gitignore 命中目录：不递归进入
      if (ignoreMatcher(relPath, true)) continue
      await walk(root, fullPath, snapshot, stats, options, ignoreMatcher)
    } else {
      if (ignoreMatcher(relPath, false)) continue

      const result = await readFileSnapshot(fullPath, size => {
        stats.fileCount++
        stats.totalBytes += size
        if (options.includeContent === false) return false
        // 预算超限：只记 mtime，不读 content
        if (isBudgetExceeded(stats, options)) {
          stats.budgetLimited++
          return false
        }
        // 超大文件：只记 mtime 不读 content，避免内存爆炸
        if (size > MAX_SNAPSHOT_FILE_SIZE) {
          stats.skippedBigFiles++
          return false
        }
        return true
      })
      if (result === 'unreadable') snapshot.unreadable.add(relPath)
      else if (result !== 'missing') snapshot.files.set(relPath, result)
    }
  }
}

type MtimeScanResult =
  | { relPath: string; mtimeMs: number; size: number }
  | { relPath: string; unreadable: true }
  | undefined

async function walkMtimes(
  root: string,
  dir: string,
  snapshot: MtimeSnapshot,
  stats: SnapshotStats,
  budget: ScanBudget,
  ignoreMatcher: IgnoreMatcher
): Promise<void> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    if (!isMissingPathError(error)) snapshot.unreadable.add(toRelPath(root, dir))
    return
  }

  const pending: Promise<MtimeScanResult>[] = []
  async function flush(): Promise<void> {
    const results = await Promise.all(pending)
    pending.length = 0
    for (const result of results) {
      if (!result) continue
      if ('unreadable' in result) {
        snapshot.unreadable.add(result.relPath)
        continue
      }
      stats.fileCount++
      stats.totalBytes += result.size
      if (isBudgetExceeded(stats, budget)) stats.budgetLimited++
      snapshot.mtimes.set(result.relPath, result.mtimeMs)
    }
  }

  for (const entry of entries) {
    const name = entry.name
    if (isPathSkipped(name)) continue

    const fullPath = join(dir, name)
    const relPath = toRelPath(root, fullPath)

    let isDir: boolean
    try {
      isDir = entry.isDirectory()
    } catch {
      await flush()
      try {
        isDir = (await stat(fullPath)).isDirectory()
      } catch (error) {
        if (!isMissingPathError(error)) snapshot.unreadable.add(relPath)
        continue
      }
    }

    if (isDir) {
      if (ignoreMatcher(relPath, true)) continue
      await flush()
      await walkMtimes(root, fullPath, snapshot, stats, budget, ignoreMatcher)
    } else {
      if (ignoreMatcher(relPath, false)) continue

      pending.push(stat(fullPath).then(
        (fileStat): MtimeScanResult => ({ relPath, mtimeMs: fileStat.mtimeMs, size: fileStat.size }),
        (error): MtimeScanResult => (isMissingPathError(error) ? undefined : { relPath, unreadable: true })
      ))
      if (pending.length === 8) await flush()
    }
  }
  // 结果只在此扫描内按发现顺序写入。
  await flush()
}
