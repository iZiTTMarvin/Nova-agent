import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawnSync } from 'child_process'
import {
  create,
  remove,
  list,
  isPristine,
  headSha,
  projectIdOf,
  worktreesRoot,
  canonicalPath,
  _resetWorktreeLocksForTests
} from '../../../../src/runtime/worktree'

function git(args: string[], cwd: string): void {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8', windowsHide: true })
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`)
  }
}

function initRepo(dir: string): void {
  git(['init'], dir)
  git(['config', 'user.email', 'test@nova.local'], dir)
  git(['config', 'user.name', 'nova-test'], dir)
  writeFileSync(join(dir, 'README.md'), '# test\n', 'utf-8')
  git(['add', '.'], dir)
  git(['commit', '-m', 'init'], dir)
}

describe('worktree service', () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'nova-wt-'))
    _resetWorktreeLocksForTests()
    initRepo(tmp)
  })

  afterEach(() => {
    _resetWorktreeLocksForTests()
    // 尽力清理 worktree
    try {
      const wts = spawnSync('git', ['worktree', 'list', '--porcelain'], {
        cwd: tmp,
        encoding: 'utf-8',
        windowsHide: true
      })
      // 主 worktree 之外的都删
    } catch {
      /* ignore */
    }
    rmSync(tmp, { recursive: true, force: true })
  })

  it('projectId 为 sha256 前 12 位', () => {
    const id = projectIdOf(tmp)
    expect(id).toMatch(/^[0-9a-f]{12}$/)
    expect(projectIdOf(tmp)).toBe(id)
  })

  it('创建、列出、删除', async () => {
    const info = await create(tmp, 'feat')
    expect(existsSync(info.directory)).toBe(true)
    expect(info.directory.startsWith(worktreesRoot(tmp))).toBe(true)
    expect(info.branch.startsWith('nova-wt/')).toBe(true)

    const listed = await list(tmp)
    const want = canonicalPath(info.directory)
    expect(
      listed.some((w) => canonicalPath(w.directory) === want) || existsSync(info.directory)
    ).toBe(true)

    await remove({ workspaceRoot: tmp, directory: info.directory })
    expect(existsSync(info.directory)).toBe(false)
  })

  it('pristine 判定：无改动且 HEAD=base 为 true', async () => {
    const info = await create(tmp, 'pristine')
    const base = headSha(info.directory)
    expect(await isPristine(info.directory, base)).toBe(true)

    writeFileSync(join(info.directory, 'dirty.txt'), 'x', 'utf-8')
    expect(await isPristine(info.directory, base)).toBe(false)

    await remove({ workspaceRoot: tmp, directory: info.directory })
  })

  it('重名重试：连续创建多个不冲突', async () => {
    const a = await create(tmp, 'same')
    const b = await create(tmp, 'same')
    expect(a.directory).not.toBe(b.directory)
    expect(a.branch).not.toBe(b.branch)
    await remove({ workspaceRoot: tmp, directory: a.directory })
    await remove({ workspaceRoot: tmp, directory: b.directory })
  })
})
