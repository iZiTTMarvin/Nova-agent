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
 * - 已支持 abortSignal，用户取消时中断遍历
 */
import { readdir, stat, readFile } from 'fs/promises'
import { join, relative } from 'path'
import { isPathSkipped, loadIgnoreMatcher, type IgnoreMatcher } from '../tools/pathExclusions'

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

export interface SnapshotOptions {
  /** 取消信号，遍历过程中会定期检查，命中即中断。 */
  abortSignal?: AbortSignal
  /** 最大处理文件数，超出后后续文件只记 mtime。 */
  maxFiles?: number
  /** 最大读取字节数（含已读 content），超出后后续文件只记 mtime。 */
  maxBytes?: number
}

export interface FileSnapshot {
  /**
   * 文件字节内容（二进制安全）。
   * 超大文件（>MAX_SNAPSHOT_FILE_SIZE）或预算耗尽时跳过内容读取，content 为 undefined。
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
 * 跳过大文件、排除目录、隐藏目录、gitignore 命中项及预算超限项
 */
export async function snapshotWorkspace(
  workspaceRoot: string,
  options: SnapshotOptions = {}
): Promise<WorkspaceSnapshot> {
  const snapshot: WorkspaceSnapshot = new Map()
  const stats: SnapshotStats = { fileCount: 0, totalBytes: 0, skippedBigFiles: 0, budgetLimited: 0 }
  const ignoreMatcher = await loadIgnoreMatcher(workspaceRoot)
  await timedSnapshot('snapshotWorkspace', async () => {
    await walk(workspaceRoot, workspaceRoot, snapshot, stats, options, ignoreMatcher)
    return stats
  })
  return snapshot
}

/** 仅采集 mtime 的轻量快照，用于执行后对比 */
export type MtimeSnapshot = Map<string, number>

export async function snapshotMtimes(
  workspaceRoot: string,
  options: SnapshotOptions = {}
): Promise<MtimeSnapshot> {
  const mtimes: MtimeSnapshot = new Map()
  const stats: SnapshotStats = { fileCount: 0, totalBytes: 0, skippedBigFiles: 0, budgetLimited: 0 }
  const ignoreMatcher = await loadIgnoreMatcher(workspaceRoot)
  await timedSnapshot('snapshotMtimes   ', async () => {
    await walkMtimes(workspaceRoot, workspaceRoot, mtimes, stats, options, ignoreMatcher)
    return stats
  })
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

function isBudgetExceeded(stats: SnapshotStats, options: SnapshotOptions): boolean {
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
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
  } catch { return }

  for (const entry of entries) {
    if (options.abortSignal?.aborted) return

    const name = entry.name
    if (isPathSkipped(name)) continue

    const fullPath = join(dir, name)
    const relPath = relative(root, fullPath).replace(/\\/g, '/')

    let isDir: boolean
    try {
      // Dirent.isDirectory() 免 stat；符号链接断裂等边缘情况补一次异步 stat
      isDir = entry.isDirectory()
    } catch {
      try {
        isDir = (await stat(fullPath)).isDirectory()
      } catch {
        continue
      }
    }

    if (isDir) {
      // gitignore 命中目录：不递归进入
      if (ignoreMatcher(relPath, true)) continue
      await walk(root, fullPath, snapshot, stats, options, ignoreMatcher)
    } else {
      if (ignoreMatcher(relPath, false)) continue

      try {
        const fileStat = await stat(fullPath)
        stats.fileCount++
        stats.totalBytes += fileStat.size

        // 预算超限：只记 mtime，不读 content
        if (isBudgetExceeded(stats, options)) {
          stats.budgetLimited++
          snapshot.set(relPath, { mtimeMs: fileStat.mtimeMs, size: fileStat.size })
          continue
        }

        // 超大文件：只记 mtime 不读 content，避免内存爆炸
        if (fileStat.size > MAX_SNAPSHOT_FILE_SIZE) {
          stats.skippedBigFiles++
          snapshot.set(relPath, { mtimeMs: fileStat.mtimeMs, size: fileStat.size })
          continue
        }

        // 用 Buffer 读，二进制安全
        const content = await readFile(fullPath)
        snapshot.set(relPath, { content, mtimeMs: fileStat.mtimeMs, size: fileStat.size })
      } catch {
        continue
      }
    }
  }
}

async function walkMtimes(
  root: string,
  dir: string,
  mtimes: MtimeSnapshot,
  stats: SnapshotStats,
  options: SnapshotOptions,
  ignoreMatcher: IgnoreMatcher
): Promise<void> {
  if (options.abortSignal?.aborted) return

  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch { return }

  for (const entry of entries) {
    if (options.abortSignal?.aborted) return

    const name = entry.name
    if (isPathSkipped(name)) continue

    const fullPath = join(dir, name)
    const relPath = relative(root, fullPath).replace(/\\/g, '/')

    let isDir: boolean
    try {
      isDir = entry.isDirectory()
    } catch {
      try {
        isDir = (await stat(fullPath)).isDirectory()
      } catch {
        continue
      }
    }

    if (isDir) {
      if (ignoreMatcher(relPath, true)) continue
      await walkMtimes(root, fullPath, mtimes, stats, options, ignoreMatcher)
    } else {
      if (ignoreMatcher(relPath, false)) continue

      try {
        const fileStat = await stat(fullPath)
        stats.fileCount++
        stats.totalBytes += fileStat.size

        // mtime 快照也受预算保护，避免极端情况下 stat 太多文件
        if (isBudgetExceeded(stats, options)) {
          stats.budgetLimited++
          continue
        }

        mtimes.set(relPath, fileStat.mtimeMs)
      } catch {
        continue
      }
    }
  }
}
