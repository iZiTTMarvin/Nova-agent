import { readdir, rm, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { getCodeGraphRoot } from '../CodeGraphPaths'

export const CODE_GRAPH_CACHE_RETENTION_DAYS = 30
export const CODE_GRAPH_CACHE_MAX_BYTES = 2 * 1024 * 1024 * 1024

export interface CodeGraphCacheGcOptions {
  readonly appDataPath: string
  readonly activeWorkspaceIdentity: string | null
  readonly retentionDays?: number
  readonly maxBytes?: number
  readonly now?: () => number
  readonly readLastAccessed?: (dbPath: string) => number
}

export interface CodeGraphCacheGcResult {
  readonly freedBytes: number
  readonly retainedBytes: number
  readonly removedWorkspaceIdentities: readonly string[]
  readonly diagnostics: readonly string[]
}

interface CacheEntry {
  readonly identity: string
  readonly path: string
  readonly bytes: number
  readonly lastAccessed: number
}

/** 代码索引是可重建缓存；回收失败只能留下诊断，不能阻断应用启动。 */
export async function runCodeGraphCacheGc(
  options: CodeGraphCacheGcOptions
): Promise<CodeGraphCacheGcResult> {
  const retentionDays = options.retentionDays ?? CODE_GRAPH_CACHE_RETENTION_DAYS
  const maxBytes = options.maxBytes ?? CODE_GRAPH_CACHE_MAX_BYTES
  if (!Number.isFinite(retentionDays) || retentionDays < 0) {
    throw new Error('代码索引缓存保留天数必须是非负数')
  }
  if (!Number.isFinite(maxBytes) || maxBytes < 0) {
    throw new Error('代码索引缓存容量上限必须是非负数')
  }

  const root = resolve(getCodeGraphRoot(options.appDataPath))
  const diagnostics: string[] = []
  const entries = await readEntries(root, options.readLastAccessed ?? readLastAccessed, diagnostics)
  const removed: string[] = []
  let retainedBytes = entries.reduce((total, entry) => total + entry.bytes, 0)
  let freedBytes = 0
  const cutoff = (options.now ?? Date.now)() - retentionDays * 24 * 60 * 60 * 1000
  const candidates = entries
    .filter((entry) => entry.identity !== options.activeWorkspaceIdentity)
    .sort((left, right) =>
      left.lastAccessed - right.lastAccessed || left.identity.localeCompare(right.identity, 'en')
    )

  for (const entry of candidates) {
    if (entry.lastAccessed >= cutoff && retainedBytes <= maxBytes) continue
    try {
      await removeCacheEntry(root, entry)
      retainedBytes -= entry.bytes
      freedBytes += entry.bytes
      removed.push(entry.identity)
    } catch (error) {
      diagnostics.push(`${entry.identity} 删除失败：${errorMessage(error)}`)
    }
  }

  return Object.freeze({
    freedBytes,
    retainedBytes,
    removedWorkspaceIdentities: Object.freeze(removed),
    diagnostics: Object.freeze(diagnostics)
  })
}

async function readEntries(
  root: string,
  readAccessed: (dbPath: string) => number,
  diagnostics: string[]
): Promise<readonly CacheEntry[]> {
  let directoryEntries
  try {
    directoryEntries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if (isMissing(error)) return []
    diagnostics.push(`索引根目录读取失败：${errorMessage(error)}`)
    return []
  }

  const entries: CacheEntry[] = []
  for (const directory of directoryEntries) {
    if (!directory.isDirectory() || !/^[a-f0-9]{16}$/.test(directory.name)) continue
    const entryPath = resolve(root, directory.name)
    if (!isDirectChild(root, entryPath)) continue
    let lastAccessed = 0
    try {
      lastAccessed = readAccessed(join(entryPath, 'index.db'))
      if (!Number.isFinite(lastAccessed) || lastAccessed < 0) {
        throw new Error('last_accessed 不是非负数')
      }
    } catch (error) {
      diagnostics.push(`${directory.name} metadata 不可读：${errorMessage(error)}`)
    }
    entries.push(Object.freeze({
      identity: directory.name,
      path: entryPath,
      bytes: await directoryBytes(entryPath),
      lastAccessed
    }))
  }
  return Object.freeze(entries)
}

function readLastAccessed(dbPath: string): number {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true })
  try {
    const row = db.prepare(
      'SELECT last_accessed AS lastAccessed FROM index_meta WHERE singleton = 1'
    ).get()
    const value = typeof row === 'object' && row !== null
      ? Reflect.get(row, 'lastAccessed')
      : null
    if (typeof value !== 'number') throw new Error('缺少 last_accessed')
    return value
  } finally {
    db.close()
  }
}

async function directoryBytes(entryPath: string): Promise<number> {
  let entries
  try {
    entries = await readdir(entryPath, { withFileTypes: true })
  } catch {
    return 0
  }
  let bytes = 0
  for (const entry of entries) {
    const child = join(entryPath, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) bytes += await directoryBytes(child)
    else {
      try {
        bytes += (await stat(child)).size
      } catch {
        // 单个缓存文件竞态消失不影响其他目录回收。
      }
    }
  }
  return bytes
}

async function removeCacheEntry(root: string, entry: CacheEntry): Promise<void> {
  if (!isDirectChild(root, entry.path) || entry.identity !== entry.path.slice(root.length + 1)) {
    throw new Error('缓存目录越出 code-graph 根目录')
  }
  await rm(entry.path, { recursive: true, force: true })
}

function isDirectChild(root: string, candidate: string): boolean {
  return candidate.startsWith(`${root}\\`) || candidate.startsWith(`${root}/`)
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'ENOENT'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
