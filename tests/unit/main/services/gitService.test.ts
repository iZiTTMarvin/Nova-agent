/**
 * gitService：状态查询、分支列表与分支变更的结构化结果。
 *
 * 除 porcelain 解析与 issue 判定表外，均在临时目录上用真实 git 仓库验证，
 * 保护「未提交计数去重、切换被脏工作区阻塞、创建重名/非法名」等真实回归。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  getGitStatus,
  listGitBranches,
  switchGitBranch,
  createGitBranchAndSwitch,
  parsePorcelainV2Status,
  classifyGitBranchMutationFailure
} from '../../../../src/main/services/gitService'

function git(cwd: string, args: string[], options?: { allowFailure?: boolean }): string {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
  } catch (error) {
    if (options?.allowFailure) return ''
    throw error
  }
}

function initRepo(dir: string): void {
  git(dir, ['init'])
  // 不依赖全局 init.defaultBranch 与提交签名配置
  git(dir, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  git(dir, ['config', 'user.name', 'Nova Test'])
  git(dir, ['config', 'user.email', 'nova-test@example.com'])
  git(dir, ['config', 'commit.gpgsign', 'false'])
}

function commitAll(dir: string, message: string): void {
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-m', message, '--no-verify'])
}

describe('parsePorcelainV2Status', () => {
  it('统计 1/2/u/? 记录；重命名记录的原路径不重复计数', () => {
    const stdout = [
      '# branch.oid abc',
      '# branch.head dev',
      '1 M. N... 100644 100644 100644 aaa bbb staged.ts',
      '2 R. N... 100644 100644 100644 aaa bbb R100 new-name.ts',
      'old-name.ts',
      'u UU N... 100644 100644 100644 100644 aaa bbb ccc conflicted.ts',
      '? untracked.ts',
      ''
    ].join('\0')

    const parsed = parsePorcelainV2Status(stdout)
    expect(parsed.branchName).toBe('dev')
    expect(parsed.headRefType).toBe('branch')
    expect(parsed.dirtyFileCount).toBe(4)
    expect(parsed.hasConflicts).toBe(true)
  })

  it('游离 HEAD 与空输出', () => {
    const detached = parsePorcelainV2Status('# branch.head (detached)\0')
    expect(detached.headRefType).toBe('detached')
    expect(detached.branchName).toBeNull()

    const empty = parsePorcelainV2Status('')
    expect(empty.dirtyFileCount).toBe(0)
    expect(empty.hasConflicts).toBe(false)
  })
})

describe('classifyGitBranchMutationFailure', () => {
  it('被覆盖的已跟踪改动：提取路径列表', () => {
    const issue = classifyGitBranchMutationFailure({
      stdout: '',
      stderr: [
        'error: Your local changes to the following files would be overwritten by checkout:',
        '\tsrc/a.ts',
        '\tREADME.md',
        'Please commit your changes or stash them before you switch branches.',
        'Aborting'
      ].join('\n')
    })
    expect(issue.code).toBe('tracked-changes-would-be-overwritten')
    expect(issue.paths).toEqual(['src/a.ts', 'README.md'])
  })

  it('未跟踪文件被覆盖、重名、非法引用、worktree 占用、冲突与进行中操作', () => {
    expect(
      classifyGitBranchMutationFailure({
        stdout: '',
        stderr: 'error: The following untracked working tree files would be overwritten by checkout:\n\tnew.txt\nAborting'
      }).code
    ).toBe('untracked-changes-would-be-overwritten')
    expect(
      classifyGitBranchMutationFailure({ stdout: '', stderr: "fatal: a branch named 'dev' already exists" }).code
    ).toBe('branch-already-exists')
    expect(
      classifyGitBranchMutationFailure({ stdout: '', stderr: 'fatal: invalid reference: missing' }).code
    ).toBe('target-branch-not-found')
    expect(
      classifyGitBranchMutationFailure({
        stdout: '',
        stderr: "fatal: 'dev' is already used by worktree at 'D:/ws'"
      }).code
    ).toBe('branch-in-other-worktree')
    expect(
      classifyGitBranchMutationFailure({
        stdout: '',
        stderr: 'error: you need to resolve your current index first'
      }).code
    ).toBe('conflicts-present')
    expect(
      classifyGitBranchMutationFailure({
        stdout: '',
        stderr: 'fatal: cannot switch branch while rebasing'
      }).code
    ).toBe('operation-in-progress')
  })

  it('未知报错兜底 mutation-failed 并保留原始输出', () => {
    const issue = classifyGitBranchMutationFailure({ stdout: '', stderr: 'fatal: something odd' })
    expect(issue.code).toBe('mutation-failed')
    expect(issue.detail).toContain('something odd')
  })
})

describe('gitService（真实临时仓库）', () => {
  let root: string
  let repo: string

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'nova-git-service-'))
    repo = join(root, 'repo')
    mkdirSync(repo, { recursive: true })
  })

  beforeEach(() => {
    rmSync(repo, { recursive: true, force: true })
    mkdirSync(repo, { recursive: true })
  })

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('非仓库目录返回 isRepository:false', async () => {
    const summary = await getGitStatus(repo)
    expect(summary.isGitAvailable).toBe(true)
    expect(summary.isRepository).toBe(false)
    expect(summary.dirtyFileCount).toBe(0)
  })

  it('干净仓库的初始状态与分支名', async () => {
    initRepo(repo)
    writeFileSync(join(repo, 'a.txt'), 'hello\n')
    commitAll(repo, 'init')

    const summary = await getGitStatus(repo)
    expect(summary.isRepository).toBe(true)
    expect(summary.branchName).toBe('main')
    expect(summary.headRefType).toBe('branch')
    expect(summary.dirtyFileCount).toBe(0)
  })

  it('未提交计数：未跟踪 + 修改 + 暂存按路径去重', async () => {
    initRepo(repo)
    writeFileSync(join(repo, 'tracked.txt'), 'v1\n')
    commitAll(repo, 'init')

    writeFileSync(join(repo, 'tracked.txt'), 'v2\n') // 修改（同时也会是部分暂存）
    writeFileSync(join(repo, 'untracked.txt'), 'new\n')
    git(repo, ['add', 'tracked.txt']) // 暂存同一路径：不得重复计数
    writeFileSync(join(repo, 'tracked.txt'), 'v3\n') // 暂存后继续修改

    const summary = await getGitStatus(repo)
    expect(summary.dirtyFileCount).toBe(2)
  })

  it('分支列表包含本地分支并标注当前分支', async () => {
    initRepo(repo)
    writeFileSync(join(repo, 'a.txt'), 'hello\n')
    commitAll(repo, 'init')
    git(repo, ['branch', 'feature-a'])

    const result = await listGitBranches(repo)
    expect(result.summary.branchName).toBe('main')
    expect(result.branches).toEqual(['feature-a', 'main'])
  })

  it('切换分支成功；同名分支为 no-op', async () => {
    initRepo(repo)
    writeFileSync(join(repo, 'a.txt'), 'hello\n')
    commitAll(repo, 'init')
    git(repo, ['branch', 'feature-a'])

    const switched = await switchGitBranch(repo, 'feature-a')
    expect(switched.ok).toBe(true)
    if (switched.ok) {
      expect(switched.didChange).toBe(true)
      expect(switched.summary.branchName).toBe('feature-a')
    }

    const noop = await switchGitBranch(repo, 'feature-a')
    expect(noop.ok).toBe(true)
    if (noop.ok) expect(noop.didChange).toBe(false)
  })

  it('本地改动会被目标分支覆盖时返回结构化 issue 与路径', async () => {
    initRepo(repo)
    writeFileSync(join(repo, 'shared.txt'), 'base\n')
    commitAll(repo, 'init')

    git(repo, ['switch', '--no-guess', '-c', 'feature'])
    writeFileSync(join(repo, 'shared.txt'), 'feature change\n')
    commitAll(repo, 'feature change')
    git(repo, ['switch', '--no-guess', 'main'])

    // main 上的未提交改动会被 feature 覆盖
    writeFileSync(join(repo, 'shared.txt'), 'main dirty\n')

    const result = await switchGitBranch(repo, 'feature')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.issue.code).toBe('tracked-changes-would-be-overwritten')
      expect(result.issue.paths?.some(path => path.includes('shared.txt'))).toBe(true)
    }
  })

  it('创建并检出新分支成功；重名返回 branch-already-exists', async () => {
    initRepo(repo)
    writeFileSync(join(repo, 'a.txt'), 'hello\n')
    commitAll(repo, 'init')

    const created = await createGitBranchAndSwitch(repo, 'feature-x')
    expect(created.ok).toBe(true)
    if (created.ok) {
      expect(created.created).toBe(true)
      expect(created.summary.branchName).toBe('feature-x')
    }

    git(repo, ['switch', '--no-guess', 'main'])
    const duplicate = await createGitBranchAndSwitch(repo, 'feature-x')
    expect(duplicate.ok).toBe(false)
    if (!duplicate.ok) expect(duplicate.issue.code).toBe('branch-already-exists')
  })

  it('非法分支名在命令执行前被拒绝', async () => {
    initRepo(repo)
    writeFileSync(join(repo, 'a.txt'), 'hello\n')
    commitAll(repo, 'init')

    const invalid = await createGitBranchAndSwitch(repo, 'bad name')
    expect(invalid.ok).toBe(false)
    if (!invalid.ok) expect(invalid.issue.code).toBe('invalid-branch-name')

    // 工作区未被弄脏
    const summary = await getGitStatus(repo)
    expect(summary.branchName).toBe('main')
  })

  it('非仓库上的切换返回 not-a-repository', async () => {
    const result = await switchGitBranch(repo, 'main')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.issue.code).toBe('not-a-repository')
  })
})
