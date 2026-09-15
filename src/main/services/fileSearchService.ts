/**
 * 工作区文件搜索：@ 引用的候选来源。
 *
 * git 仓库用 git ls-files（天然尊重 .gitignore）；非 git 目录退化为
 * 有界递归。每个工作区 5 秒 TTL 缓存（击键级响应），返回前缀命中优先的 Top N。
 */
import { execFile } from 'child_process'
import { readdirSync } from 'fs'
import { join, relative, sep } from 'path'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

const CACHE_TTL_MS = 5_000
const MAX_RESULTS = 50
const RECURSIVE_SCAN_LIMIT = 5_000
const RECURSIVE_IGNORED_DIRS: ReadonlySet<string> = new Set([
  'node_modules', '.git', '.next', 'dist', 'out', 'build', '.venv', '__pycache__', 'target'
])

interface WorkspaceFileCache {
  files: string[]
  loadedAt: number
  /** git 仓库标记：非 git 的降级扫描结果标注来源 */
  fromGit: boolean
}

const caches = new Map<string, WorkspaceFileCache>()

export interface FileSearchResult {
  files: string[]
  /** 候选来源：git 索引或降级递归 */
  source: 'git' | 'recursive'
}

async function listGitFiles(workspaceRoot: string): Promise<string[] | null> {
  try {
    const { stdout } = await execFileAsync('git', ['ls-files'], {
      cwd: workspaceRoot,
      maxBuffer: 16 * 1024 * 1024,
      timeout: 5_000,
      windowsHide: true
    })
    return stdout.split('\n').map(line => line.trim()).filter(line => line.length > 0)
  } catch {
    return null
  }
}

function listRecursiveFiles(workspaceRoot: string): string[] {
  const out: string[] = []
  const walk = (dir: string, depth: number): void => {
    if (out.length >= RECURSIVE_SCAN_LIMIT || depth > 8) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (out.length >= RECURSIVE_SCAN_LIMIT) return
      if (entry.name.startsWith('.') || RECURSIVE_IGNORED_DIRS.has(entry.name)) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full, depth + 1)
      } else {
        // walk 只从根内出发且不跟随符号链接，rel 必然是根内相对路径；
        // 路径越界判定统一归 pathAccess，这里不做安全判断
        const rel = relative(workspaceRoot, full)
        if (rel) out.push(rel.split(sep).join('/'))
      }
    }
  }
  walk(workspaceRoot, 0)
  return out
}

async function loadFiles(workspaceRoot: string): Promise<WorkspaceFileCache> {
  const cached = caches.get(workspaceRoot)
  if (cached && Date.now() - cached.loadedAt < CACHE_TTL_MS) return cached

  const gitFiles = await listGitFiles(workspaceRoot)
  const next: WorkspaceFileCache = gitFiles
    ? { files: gitFiles, loadedAt: Date.now(), fromGit: true }
    : { files: listRecursiveFiles(workspaceRoot), loadedAt: Date.now(), fromGit: false }
  caches.set(workspaceRoot, next)
  // 有界：工作区切换频繁也不积累
  if (caches.size > 8) {
    for (const key of caches.keys()) {
      if (caches.size <= 8) break
      caches.delete(key)
    }
  }
  return next
}

/** 前缀命中优先于子串命中；同级保持索引序（git 输出即路径字典序） */
export async function searchWorkspaceFiles(workspaceRoot: string, query: string): Promise<FileSearchResult> {
  const cache = await loadFiles(workspaceRoot)
  const q = query.trim().toLowerCase()
  if (!q) {
    return { files: cache.files.slice(0, MAX_RESULTS), source: cache.fromGit ? 'git' : 'recursive' }
  }
  const prefixHits: string[] = []
  const substringHits: string[] = []
  for (const file of cache.files) {
    const lower = file.toLowerCase()
    if (lower.startsWith(q)) {
      prefixHits.push(file)
      if (prefixHits.length >= MAX_RESULTS) break
    } else if (lower.includes(q) && substringHits.length < MAX_RESULTS) {
      substringHits.push(file)
    }
  }
  return {
    files: [...prefixHits, ...substringHits].slice(0, MAX_RESULTS),
    source: cache.fromGit ? 'git' : 'recursive'
  }
}
