/**
 * Git worktree 隔离：路径 `.nova/worktrees/<projectId>/<slug>-<random>/`
 * per-parent-repo 锁防止 `git worktree add` 的 index.lock 竞争。
 */
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, realpathSync, rmSync } from 'fs'
import { join, resolve, normalize } from 'path'
import { spawnSync } from 'child_process'
import { makeSemaphore, type Semaphore } from '../workflow/scheduling/semaphore'

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

/** 判断 workspaceRoot 是否在已提交的 git 仓库内，供上层决定能否使用 worktree 隔离。 */
export function isGitRepo(workspaceRoot: string): boolean {
  const inside = runGit(['rev-parse', '--is-inside-work-tree'], workspaceRoot)
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') return false
  const head = runGit(['rev-parse', 'HEAD'], workspaceRoot)
  return head.code === 0
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
    throw new Error('Worktrees are only supported for git projects with at least one commit')
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

export interface CommitAllResult {
  /** 是否产生了新提交（无改动时为 false） */
  committed: boolean
  sha: string | null
  error?: string
}

/**
 * 把 worktree 内的全部改动提交到其自身分支。
 * integrate 前必须提交：git merge 只能合并已提交内容。
 * 提交者身份取仓库配置；未配置时用 -c 覆盖，避免因缺少 user.email 而整条编排卡死。
 */
export function commitAll(input: {
  directory: string
  message: string
}): CommitAllResult {
  const { directory, message } = input
  const added = runGit(['add', '-A'], directory)
  if (added.code !== 0) {
    return { committed: false, sha: null, error: added.stderr || added.stdout }
  }
  const staged = runGit(['diff', '--cached', '--quiet'], directory)
  // exit 0 = 无暂存差异；1 = 有差异；其他值视为 git 出错
  if (staged.code === 0) {
    return { committed: false, sha: null }
  }
  const commit = runGit(
    [
      '-c',
      'user.name=nova-agent',
      '-c',
      'user.email=nova-agent@localhost',
      'commit',
      '--no-verify',
      '-m',
      message
    ],
    directory
  )
  if (commit.code !== 0) {
    return { committed: false, sha: null, error: commit.stderr || commit.stdout }
  }
  let sha: string | null = null
  const head = runGit(['rev-parse', 'HEAD'], directory)
  if (head.code === 0) sha = head.stdout.trim()
  return { committed: true, sha }
}

export type MergeStrategy = 'fast-forward' | 'three-way'

export type MergeBranchResult =
  | { status: 'merged'; strategy: MergeStrategy; sha: string | null }
  /** up_to_date：目标分支内容已在主分支上，无需合并 */
  | { status: 'up_to_date' }
  /** conflict：冲突现场原样保留，交由上层的 integrate agent 处理 */
  | { status: 'conflict'; files: string[] }
  | { status: 'failed'; error: string }

/**
 * 把 worktree 分支合并回主工作区当前分支：先 fast-forward，失败再 3-way。
 *
 * 不做 `git merge --abort`：冲突现场必须保留，否则 integrate agent 无从解决。
 * 主工作区若有未提交改动，交由 git 自身拒绝（仅当会被覆盖时），本层不额外预检——
 * 单任务批本就直接在主工作区改文件，预检会把正常流程判死。
 * 与 create/remove 共用 per-repo 锁，避免与并行 worktree 操作抢 index.lock。
 */
export async function mergeBranch(input: {
  workspaceRoot: string
  branch: string
  /** 3-way 合并的提交信息 */
  message?: string
}): Promise<MergeBranchResult> {
  const { workspaceRoot, branch } = input
  return lockFor(workspaceRoot).run(async () => {
    const ancestor = runGit(['merge-base', '--is-ancestor', branch, 'HEAD'], workspaceRoot)
    if (ancestor.code === 0) return { status: 'up_to_date' } as MergeBranchResult

    const ff = runGit(['merge', '--ff-only', branch], workspaceRoot)
    if (ff.code === 0) {
      const head = runGit(['rev-parse', 'HEAD'], workspaceRoot)
      return {
        status: 'merged',
        strategy: 'fast-forward',
        sha: head.code === 0 ? head.stdout.trim() : null
      }
    }

    const threeWay = runGit(
      [
        '-c',
        'user.name=nova-agent',
        '-c',
        'user.email=nova-agent@localhost',
        'merge',
        '--no-ff',
        '--no-edit',
        '-m',
        input.message ?? `merge ${branch}`,
        branch
      ],
      workspaceRoot
    )
    if (threeWay.code === 0) {
      const head = runGit(['rev-parse', 'HEAD'], workspaceRoot)
      return {
        status: 'merged',
        strategy: 'three-way',
        sha: head.code === 0 ? head.stdout.trim() : null
      }
    }

    const conflicts = conflictFiles(workspaceRoot)
    if (conflicts.length > 0 || isMergeInProgress(workspaceRoot)) {
      return { status: 'conflict', files: conflicts }
    }
    return { status: 'failed', error: threeWay.stderr || threeWay.stdout || 'merge failed' }
  })
}

/** 未解决冲突的文件列表（相对仓库根，正斜杠） */
export function conflictFiles(workspaceRoot: string): string[] {
  const result = runGit(['diff', '--name-only', '--diff-filter=U'], workspaceRoot)
  if (result.code !== 0) return []
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

/** 是否处于未完成的 merge 中（MERGE_HEAD 存在） */
export function isMergeInProgress(workspaceRoot: string): boolean {
  const result = runGit(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], workspaceRoot)
  return result.code === 0 && result.stdout.trim() !== ''
}

/** 当前 HEAD sha；不在仓库或读取失败时返回 null（诊断用，不抛） */
export function tryHeadSha(directory: string): string | null {
  const result = runGit(['rev-parse', 'HEAD'], directory)
  return result.code === 0 ? result.stdout.trim() : null
}
