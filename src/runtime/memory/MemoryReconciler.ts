/**
 * 记忆目录 reconcile：按 fingerprint=size-mtimeMs 增量同步索引。
 * 文件扫描为纯函数/可注入，diff 逻辑可在单测中脱离磁盘验证。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { join, relative } from 'path'
import type { MemoryDb } from './MemoryDb'
import type { ReconcilePlan, ReconcileStats, ScannedMemoryFile, MemoryScopeFileEntry } from './types'
import { computeFingerprint } from './FtsQueryBuilder'
import {
  deleteIndexedFile,
  listIndexedFingerprints,
  upsertIndexedFile
} from './MemoryIndexer'

/**
 * 递归扫描 scope 目录下全部 .md 文件
 * @param scopeDir getProjectMemoryDir 返回值
 */
export function scanScopeMarkdownFiles(scopeDir: string): ScannedMemoryFile[] {
  if (!existsSync(scopeDir)) {
    return []
  }

  const results: ScannedMemoryFile[] = []

  function walk(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        const stat = statSync(full)
        const mtimeMs = Math.floor(stat.mtimeMs)
        const size = stat.size
        const relPath = relative(scopeDir, full).split(/[/\\]/).join('/')
        const body = readFileSync(full, 'utf8')
        results.push({
          relPath,
          body,
          size,
          mtimeMs,
          fingerprint: computeFingerprint(size, mtimeMs)
        })
      }
    }
  }

  walk(scopeDir)
  return results
}

/**
 * 递归列出 scope 目录下全部 .md 文件元信息（不读正文，供 UI 列表展示）
 */
export function listScopeMarkdownFileMeta(scopeDir: string): MemoryScopeFileEntry[] {
  if (!existsSync(scopeDir)) {
    return []
  }

  const results: MemoryScopeFileEntry[] = []

  function walk(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        const stat = statSync(full)
        results.push({
          relPath: relative(scopeDir, full).split(/[/\\]/).join('/'),
          size: stat.size,
          mtimeMs: Math.floor(stat.mtimeMs)
        })
      }
    }
  }

  walk(scopeDir)
  return results
}

/**
 * 对比磁盘文件与索引指纹，产出增删改计划（纯逻辑）
 */
export function planReconcileDiff(
  diskFiles: ScannedMemoryFile[],
  indexedFingerprints: Map<string, string>
): ReconcilePlan {
  const diskMap = new Map(diskFiles.map((f) => [f.relPath, f]))
  const added: ScannedMemoryFile[] = []
  const updated: ScannedMemoryFile[] = []
  const removed: string[] = []

  for (const file of diskFiles) {
    const prev = indexedFingerprints.get(file.relPath)
    if (prev === undefined) {
      added.push(file)
    } else if (prev !== file.fingerprint) {
      updated.push(file)
    }
  }

  for (const relPath of indexedFingerprints.keys()) {
    if (!diskMap.has(relPath)) {
      removed.push(relPath)
    }
  }

  return { added, updated, removed }
}

/**
 * 将 reconcile 计划写入索引
 */
export function applyReconcilePlan(
  db: MemoryDb,
  scopeId: string,
  plan: ReconcilePlan
): ReconcileStats {
  for (const relPath of plan.removed) {
    deleteIndexedFile(db, scopeId, relPath)
  }
  for (const file of [...plan.added, ...plan.updated]) {
    upsertIndexedFile(db, scopeId, file)
  }

  return {
    added: plan.added.length,
    updated: plan.updated.length,
    removed: plan.removed.length,
    skipped: 0
  }
}

/**
 * 全量 reconcile 单个 scope：扫盘 → diff → 写索引
 */
export function reconcileScope(
  db: MemoryDb,
  scopeId: string,
  scopeDir: string,
  scan: (dir: string) => ScannedMemoryFile[] = scanScopeMarkdownFiles
): ReconcileStats {
  const diskFiles = scan(scopeDir)
  const indexed = listIndexedFingerprints(db, scopeId)
  const plan = planReconcileDiff(diskFiles, indexed)

  const stats = applyReconcilePlan(db, scopeId, plan)
  const totalOnDisk = diskFiles.length
  stats.skipped = totalOnDisk - stats.added - stats.updated
  return stats
}
