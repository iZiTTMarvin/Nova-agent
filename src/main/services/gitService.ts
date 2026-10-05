/**
 * gitService — 对指定工作区执行 Git 状态查询与分支切换
 *
 * 主进程唯一执行 git 命令的位置（Composer 分支 chip 的数据源）。
 * 把 Git 原生报错归一为稳定 issue code，不拥有会话、权限与 UI 状态；
 * 工作区空闲校验由 handler 负责，本模块不感知会话。
 */
import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { isAbsolute, resolve } from 'path'
import { promisify } from 'util'
import type {
  GitStatusSummary,
  GitBranchListResult,
  GitBranchIssue,
  GitBranchMutationResult,
  GitHeadRefType
} from '../../shared/git/types'

const execFileAsync = promisify(execFile)

const GIT_TIMEOUT_MS = 8_000
const GIT_MAX_BUFFER = 4 * 1024 * 1024
/** issue 路径提取上限：异常输出不撑爆 UI */
const MAX_ISSUE_PATHS = 20

/** 进行中 Git 操作的标记文件（相对 git dir 解析） */
const GIT_OPERATION_MARKERS = [
  'MERGE_HEAD',
  'rebase-merge',
  'rebase-apply',
  'CHERRY_PICK_HEAD',
  'REVERT_HEAD'
] as const

interface GitCommandResult {
  ok: boolean
  stdout: string
  stderr: string
  /** 输出超过 maxBuffer：调用方可降级重跑 */
  bufferExceeded: boolean
  /** git 可执行文件不存在 */
  binaryMissing: boolean
}

async function runGit(args: string[], cwd: string): Promise<GitCommandResult> {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
      windowsHide: true
    })
    return { ok: true, stdout, stderr, bufferExceeded: false, binaryMissing: false }
  } catch (error) {
    // execFile 非 0 退出时错误对象同样携带 stdout/stderr
    const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string }
    return {
      ok: false,
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? '',
      bufferExceeded: err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
      binaryMissing: err.code === 'ENOENT'
    }
  }
}

/** porcelain=v2 输出的解析结果（内部使用，含冲突探测） */
export interface ParsedGitStatus {
  branchName: string | null
  headRefType: GitHeadRefType
  dirtyFileCount: number
  hasConflicts: boolean
}

/**
 * 解析 `git status --porcelain=v2 --branch -z` 输出。
 * 只统计 1/2/u/? 前缀的记录；2（重命名）记录的第二段是原路径，不重复计数。
 */
export function parsePorcelainV2Status(stdout: string): ParsedGitStatus {
  let branchName: string | null = null
  let headRefType: GitHeadRefType = 'branch'
  let dirtyFileCount = 0
  let hasConflicts = false

  const tokens = stdout.split('\0')
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (!token) continue

    if (token.startsWith('#')) {
      if (token.startsWith('# branch.head ')) {
        const value = token.slice('# branch.head '.length)
        if (value === '(detached)') {
          headRefType = 'detached'
          branchName = null
        } else {
          branchName = value
        }
      }
      continue
    }

    const kind = token.charAt(0)
    if (kind === '1' || kind === 'u' || kind === '?') {
      dirtyFileCount += 1
      if (kind === 'u') hasConflicts = true
    } else if (kind === '2') {
      dirtyFileCount += 1
      index += 1 // 跳过重命名记录携带的原路径
    }
  }

  return { branchName, headRefType, dirtyFileCount, hasConflicts }
}

/** 从缩进行提取受影响路径（"would be overwritten" 报错列表） */
function extractIndentedPaths(lines: string[], trigger: RegExp): string[] {
  const paths: string[] = []
  let collecting = false
  for (const line of lines) {
    if (!collecting) {
      if (trigger.test(line.trim().toLowerCase())) collecting = true
      continue
    }
    if (!/^\s+/.test(line)) break
    const value = line.trim().replace(/^"|"$/g, '')
    if (value) paths.push(value)
    if (paths.length >= MAX_ISSUE_PATHS) break
  }
  return paths
}

/**
 * 把 git 分支命令的失败输出归一为稳定 issue code。
 * 判定表与 ZCode `parseGitBranchMutationIssues` 对齐；末尾兜底 mutation-failed。
 */
export function classifyGitBranchMutationFailure(output: {
  stdout: string
  stderr: string
}): GitBranchIssue {
  const detail = output.stderr.trim() || output.stdout.trim() || undefined
  const lines = (detail ?? '').replace(/\r\n/g, '\n').split('\n')
  const normalized = (detail ?? '').toLowerCase()

  const trackedOverwritePaths = extractIndentedPaths(
    lines,
    /your local changes to the following files would be overwritten by (checkout|switch)/
  )
  if (trackedOverwritePaths.length > 0) {
    return { code: 'tracked-changes-would-be-overwritten', paths: trackedOverwritePaths, detail }
  }

  const untrackedOverwritePaths = extractIndentedPaths(
    lines,
    /the following untracked working tree files would be overwritten by (checkout|switch)/
  )
  if (untrackedOverwritePaths.length > 0) {
    return { code: 'untracked-changes-would-be-overwritten', paths: untrackedOverwritePaths, detail }
  }

  if (normalized.includes('already exists')) {
    return { code: 'branch-already-exists', detail }
  }
  if (normalized.includes('invalid reference:')) {
    return { code: 'target-branch-not-found', detail }
  }
  if (normalized.includes('is already used by worktree at')) {
    return { code: 'branch-in-other-worktree', detail }
  }
  if (normalized.includes('resolve your current index first')) {
    return { code: 'conflicts-present', detail }
  }
  if (
    /cannot switch branch while (merging|rebasing|cherry-picking|reverting|bisecting)/.test(
      normalized
    ) ||
    normalized.includes('you have not concluded your merge') ||
    normalized.includes('rebase in progress')
  ) {
    return { code: 'operation-in-progress', detail }
  }

  return { code: 'mutation-failed', detail }
}

/** git 可执行文件不存在 / 目录不是仓库时返回 issue，否则 null */
async function ensureRepository(workspaceRoot: string): Promise<GitBranchIssue | null> {
  const probe = await runGit(['rev-parse', '--is-inside-work-tree'], workspaceRoot)
  if (probe.binaryMissing) {
    return { code: 'not-a-repository', detail: '未找到可用的 git 可执行文件' }
  }
  if (!probe.ok || probe.stdout.trim() !== 'true') {
    return { code: 'not-a-repository' }
  }
  return null
}

/** 读取仓库状态；-uall 输出超限时降级为 -unormal（目录折叠）重跑一次 */
async function readRepositoryStatus(workspaceRoot: string): Promise<ParsedGitStatus> {
  let result = await runGit(
    ['status', '--porcelain=v2', '--branch', '--untracked-files=all', '-z'],
    workspaceRoot
  )
  if (result.bufferExceeded) {
    result = await runGit(
      ['status', '--porcelain=v2', '--branch', '--untracked-files=normal', '-z'],
      workspaceRoot
    )
  }
  if (!result.ok) {
    const message = result.stderr.trim() || result.stdout.trim() || '未知原因'
    throw new Error(`git status 执行失败：${message}`)
  }
  return parsePorcelainV2Status(result.stdout)
}

function toSummary(parsed: ParsedGitStatus): GitStatusSummary {
  return {
    isGitAvailable: true,
    isRepository: true,
    branchName: parsed.branchName,
    headRefType: parsed.headRefType,
    dirtyFileCount: parsed.dirtyFileCount
  }
}

/** 当前工作区 Git 摘要（chip 展示用） */
export async function getGitStatus(workspaceRoot: string): Promise<GitStatusSummary> {
  const probe = await runGit(['rev-parse', '--is-inside-work-tree'], workspaceRoot)
  if (probe.binaryMissing) {
    return {
      isGitAvailable: false,
      isRepository: false,
      branchName: null,
      headRefType: 'branch',
      dirtyFileCount: 0
    }
  }
  if (!probe.ok || probe.stdout.trim() !== 'true') {
    return {
      isGitAvailable: true,
      isRepository: false,
      branchName: null,
      headRefType: 'branch',
      dirtyFileCount: 0
    }
  }
  return toSummary(await readRepositoryStatus(workspaceRoot))
}

/** 本地分支列表（与摘要同一次快照）；非仓库返回空列表 */
export async function listGitBranches(workspaceRoot: string): Promise<GitBranchListResult> {
  const summary = await getGitStatus(workspaceRoot)
  if (!summary.isGitAvailable || !summary.isRepository) {
    return { summary, branches: [] }
  }

  const result = await runGit(
    ['for-each-ref', 'refs/heads', '--format=%(refname:short)'],
    workspaceRoot
  )
  if (!result.ok) {
    throw new Error(`git for-each-ref 执行失败：${result.stderr.trim() || '未知原因'}`)
  }

  const branches = result.stdout
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0)
  return { summary, branches }
}

/** 进行中操作探测：git-path 标记文件存在即视为 merge/rebase 等未完成 */
async function hasOperationInProgress(workspaceRoot: string): Promise<boolean> {
  const result = await runGit(
    ['rev-parse', ...GIT_OPERATION_MARKERS.flatMap(marker => ['--git-path', marker])],
    workspaceRoot
  )
  if (!result.ok) return false
  return result.stdout
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .some(path => existsSync(isAbsolute(path) ? path : resolve(workspaceRoot, path)))
}

/** 用 git 自身的 ref 规则校验分支名 */
async function validateBranchName(
  workspaceRoot: string,
  branchName: string
): Promise<GitBranchIssue | null> {
  const result = await runGit(['check-ref-format', '--branch', branchName], workspaceRoot)
  if (result.ok) return null
  return { code: 'invalid-branch-name', detail: result.stderr.trim() || undefined }
}

/** 分支变更的公共预检：空名 / 冲突 / 进行中操作 / 非法名；返回 null 表示可继续 */
async function precheckBranchMutation(
  workspaceRoot: string,
  branchName: string
): Promise<GitBranchIssue | null> {
  if (!branchName) {
    return { code: 'invalid-branch-name' }
  }

  const status = await readRepositoryStatus(workspaceRoot)
  if (status.hasConflicts) {
    return { code: 'conflicts-present' }
  }
  if (await hasOperationInProgress(workspaceRoot)) {
    return { code: 'operation-in-progress' }
  }
  return validateBranchName(workspaceRoot, branchName)
}

/** 切换本地分支；失败返回结构化 issue，同名分支为 no-op 成功 */
export async function switchGitBranch(
  workspaceRoot: string,
  branchName: string
): Promise<GitBranchMutationResult> {
  const repositoryIssue = await ensureRepository(workspaceRoot)
  if (repositoryIssue) return { ok: false, issue: repositoryIssue }

  const normalized = branchName.trim()
  const status = await readRepositoryStatus(workspaceRoot)
  if (status.headRefType === 'branch' && status.branchName === normalized) {
    return { ok: true, didChange: false, created: false, summary: toSummary(status) }
  }

  const precheckIssue = await precheckBranchMutation(workspaceRoot, normalized)
  if (precheckIssue) return { ok: false, issue: precheckIssue }

  const result = await runGit(['switch', '--no-guess', normalized], workspaceRoot)
  if (!result.ok) {
    return { ok: false, issue: classifyGitBranchMutationFailure(result) }
  }

  return {
    ok: true,
    didChange: true,
    created: false,
    summary: await getGitStatus(workspaceRoot)
  }
}

/** 创建并检出新分支；失败返回结构化 issue */
export async function createGitBranchAndSwitch(
  workspaceRoot: string,
  branchName: string
): Promise<GitBranchMutationResult> {
  const repositoryIssue = await ensureRepository(workspaceRoot)
  if (repositoryIssue) return { ok: false, issue: repositoryIssue }

  const normalized = branchName.trim()
  const precheckIssue = await precheckBranchMutation(workspaceRoot, normalized)
  if (precheckIssue) return { ok: false, issue: precheckIssue }

  const result = await runGit(['switch', '--no-guess', '-c', normalized], workspaceRoot)
  if (!result.ok) {
    return { ok: false, issue: classifyGitBranchMutationFailure(result) }
  }

  return {
    ok: true,
    didChange: true,
    created: true,
    summary: await getGitStatus(workspaceRoot)
  }
}
