/**
 * Git worktree 隔离：路径 `.nova/worktrees/<projectId>/<slug>-<random>/`
 * per-parent-repo 锁防止 `git worktree add` 的 index.lock 竞争。
 */
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, realpathSync, rmSync } from 'fs'
import { join, resolve, normalize } from 'path'
import { spawnSync } from 'child_process'
import { makeSemaphore, type Semaphore } from '../workflow/semaphore'

export interface WorktreeInfo {
  name: string
  branch: string
  directory: string
}

const MAX_NAME_ATTEMPTS = 26
const BRANCH_PREFIX = 'nova-wt/'

/** projectId = sha256(workspaceRoot).slice(0, 12) */
export function projectIdOf(workspaceRoot: string): string {
  return createHash('sha256').update(normalize(workspaceRoot)).digest('hex').slice(0, 12)
}

function slugify(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
    .slice(0, 32)
}

function randomSlug(): string {
  return randomBytes(3).toString('hex')
}

/** Windows 路径比较用 lowercase */
export function canonicalPath(p: string): string {
  const abs = resolve(p)
  let real = abs
  try {
    if (existsSync(abs)) real = realpathSync(abs)
  } catch {
    /* keep abs */
  }
  const n = normalize(real)
  return process.platform === 'win32' ? n.toLowerCase() : n
}

interface GitResult {
  code: number
  stdout: string
  stderr: string
}

function runGit(args: string[], cwd: string): GitResult {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf-8',
    windowsHide: true
  })
  return {
    code: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? ''
  }
}

/** per-parent-repo 锁 */
const repoLocks = new Map<string, Semaphore>()

function lockFor(workspaceRoot: string): Semaphore {
  const key = canonicalPath(workspaceRoot)
  let sem = repoLocks.get(key)
  if (!sem) {
    sem = makeSemaphore(1)
    repoLocks.set(key, sem)
  }
  return sem
}

export function worktreesRoot(workspaceRoot: string): string {
  return join(workspaceRoot, '.nova', 'worktrees', projectIdOf(workspaceRoot))
}

function isGitRepo(workspaceRoot: string): boolean {
  const r = runGit(['rev-parse', '--is-inside-work-tree'], workspaceRoot)
  return r.code === 0 && r.stdout.trim() === 'true'
}

/** 当前 HEAD sha（创建后 isPristine 的 base） */
export function headSha(directory: string): string {
  const r = runGit(['rev-parse', 'HEAD'], directory)
  if (r.code !== 0) throw new Error(r.stderr || 'Failed to read HEAD')
  return r.stdout.trim()
}

/**
 * 创建 worktree：最多 26 次重名重试，同时检查目录存在与 `git show-ref`。
 */
export async function create(workspaceRoot: string, name?: string): Promise<WorktreeInfo> {
  if (!isGitRepo(workspaceRoot)) {
    throw new Error('Worktrees are only supported for git projects')
  }

  const root = worktreesRoot(workspaceRoot)
  mkdirSync(root, { recursive: true })
  const base = name ? slugify(name) : ''

  return lockFor(workspaceRoot).run(async () => {
    for (let attempt = 0; attempt < MAX_NAME_ATTEMPTS; attempt++) {
      const nameSlug = base ? `${base}-${randomSlug()}` : randomSlug()
      const branch = `${BRANCH_PREFIX}${nameSlug}`
      const directory = join(root, nameSlug)

      if (existsSync(directory)) continue

      const ref = `refs/heads/${branch}`
      const branchCheck = runGit(['show-ref', '--verify', '--quiet', ref], workspaceRoot)
      if (branchCheck.code === 0) continue

      const created = runGit(
        ['worktree', 'add', '-b', branch, directory],
        workspaceRoot
      )
      if (created.code !== 0) {
        if (existsSync(directory)) {
          try {
            rmSync(directory, { recursive: true, force: true })
          } catch {
            /* ignore */
          }
        }
        continue
      }

      return { name: nameSlug, branch, directory }
    }
    throw new Error('Failed to generate a unique worktree name after 26 attempts')
  })
}

/** Windows EBUSY / 句柄占用时的有界退避（ms）；禁止无限重试或只靠拉长测试 timeout */
const REMOVE_RETRY_DELAYS_MS = [50, 100, 200, 400, 800, 1600] as const

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isBusyFsError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const code = (err as NodeJS.ErrnoException).code
  return code === 'EBUSY' || code === 'EPERM' || code === 'ENOTEMPTY' || code === 'EACCES'
}

/**
 * 有界退避删除目录：child/句柄未释放时 Windows 常报 EBUSY。
 * 耗尽后抛出，并附带仍占用路径，便于日志定位（禁止静默忽略）。
 */
async function rmDirWithBusyRetry(directory: string): Promise<void> {
  if (!existsSync(directory)) return
  let lastErr: unknown
  for (let i = 0; i <= REMOVE_RETRY_DELAYS_MS.length; i++) {
    try {
      rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
      if (!existsSync(directory)) return
    } catch (err) {
      lastErr = err
      if (!isBusyFsError(err) && (err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err
      }
    }
    if (!existsSync(directory)) return
    const delay = REMOVE_RETRY_DELAYS_MS[i]
    if (delay === undefined) break
    await sleepMs(delay)
  }
  const detail = lastErr instanceof Error ? lastErr.message : String(lastErr ?? 'unknown')
  throw new Error(
    `Failed to remove worktree directory (busy after retries): ${directory}; last=${detail}`
  )
}

/**
 * 删除 worktree：fsmonitor stop → git worktree remove --force → fs.rm（有界 EBUSY 退避）→ branch -D
 *
 * 调用方应先确保占用该目录的 child process 已退出（TaskScope.close / waitForChildProcess），
 * 再调用本函数；本层只处理「进程已退但句柄短暂占用」的 Windows 竞态。
 */
export async function remove(input: {
  workspaceRoot: string
  directory: string
}): Promise<void> {
  const { workspaceRoot } = input
  const directory = canonicalPath(input.directory)

  return lockFor(workspaceRoot).run(async () => {
    let branch: string | undefined
    const list = runGit(['worktree', 'list', '--porcelain'], workspaceRoot)
    if (list.code === 0) {
      const entries = parseWorktreeList(list.stdout)
      const entry = entries.find((e) => e.path && canonicalPath(e.path) === directory)
      branch = entry?.branch?.replace(/^refs\/heads\//, '')
    }

    if (existsSync(directory)) {
      runGit(['fsmonitor--daemon', 'stop'], directory)
    }

    const removed = runGit(['worktree', 'remove', '--force', directory], workspaceRoot)

    if (existsSync(directory)) {
      await rmDirWithBusyRetry(directory)
    }

    if (branch) {
      runGit(['branch', '-D', branch], workspaceRoot)
    }

    if (removed.code !== 0 && existsSync(directory)) {
      throw new Error(removed.stderr || removed.stdout || 'Failed to remove git worktree')
    }
  })
}

function parseWorktreeList(text: string): { path?: string; branch?: string }[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .reduce<{ path?: string; branch?: string }[]>((acc, line) => {
      if (!line) return acc
      if (line.startsWith('worktree ')) {
        acc.push({ path: line.slice('worktree '.length).trim() })
        return acc
      }
      const current = acc[acc.length - 1]
      if (!current) return acc
      if (line.startsWith('branch ')) {
        current.branch = line.slice('branch '.length).trim()
      }
      return acc
    }, [])
}

/** 列出某 workspace 下由本模块创建的 worktree 目录 */
export async function list(workspaceRoot: string): Promise<WorktreeInfo[]> {
  const root = worktreesRoot(workspaceRoot)
  if (!existsSync(root)) return []
  const listResult = runGit(['worktree', 'list', '--porcelain'], workspaceRoot)
  if (listResult.code !== 0) return []
  const entries = parseWorktreeList(listResult.stdout)
  const prefix = canonicalPath(root)
  // 带分隔符的前缀，避免误匹配同前缀的兄弟目录
  const prefixWithSep = prefix.endsWith('\\') || prefix.endsWith('/') ? prefix : prefix + (process.platform === 'win32' ? '\\' : '/')
  const out: WorktreeInfo[] = []
  for (const e of entries) {
    if (!e.path) continue
    const dir = canonicalPath(e.path)
    if (dir !== prefix && !dir.startsWith(prefixWithSep)) continue
    const name = dir.slice(prefix.length).replace(/^[/\\]+/, '').split(/[/\\]/)[0]
    if (!name) continue
    out.push({
      name,
      branch: e.branch?.replace(/^refs\/heads\//, '') ?? '',
      directory: e.path
    })
  }
  return out
}

/**
 * worktree 与 base(HEAD sha) 是否一致且无本地改动。
 * pristine → 成功终态时可删除。
 */
export async function isPristine(directory: string, base: string): Promise<boolean> {
  const status = runGit(['status', '--porcelain'], directory)
  if (status.code !== 0) return false
  if (status.stdout.trim() !== '') return false
  const current = runGit(['rev-parse', 'HEAD'], directory)
  return current.code === 0 && current.stdout.trim() === base
}

/** 测试辅助：清空 per-repo 锁表 */
export function _resetWorktreeLocksForTests(): void {
  repoLocks.clear()
}
