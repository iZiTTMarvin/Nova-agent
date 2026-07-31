import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { spawnSync } from 'child_process'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  createIntegrateFn,
  ensureWorktree,
  releaseWorktree
} from '../../../../../src/runtime/workflow/host/worktreeFn'
import { hostEffectCtx } from '../../../../../src/runtime/workflow/host/types'
import { tryReuseIntegrateReceipt } from '../../../../../src/runtime/workflow/effects/integrateEffect'
import * as Worktree from '../../../../../src/runtime/worktree'
import { addTextResponse, makeHostHarness } from './hostTestContext'
import type { AgentResult } from '../../../../../src/runtime/workflow/host/types'

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

/** 记录调用次数的 agent 委托，用于断言"只有真冲突才调用 integrate agent" */
function countingAgent(result: AgentResult): {
  fn: (prompt: string) => Promise<AgentResult>
  calls: string[]
} {
  const calls: string[] = []
  return {
    calls,
    fn: async (prompt) => {
      calls.push(prompt)
      return result
    }
  }
}

describe('host worktreeFn', () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'nova-host-wt-'))
    Worktree._resetWorktreeLocksForTests()
    initRepo(tmp)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    Worktree._resetWorktreeLocksForTests()
    rmSync(tmp, { recursive: true, force: true })
  })

  it('同键第二次调用复用同一 worktree', async () => {
    const h = makeHostHarness(tmp)
    const first = await ensureWorktree(h.ctx, 'task-1')
    const second = await ensureWorktree(h.ctx, 'task-1')

    expect(second.directory).toBe(first.directory)
    expect(first.reused).toBe(false)
    expect(second.reused).toBe(true)
    expect(h.ctx.ownedWorktrees.size).toBe(1)

    const other = await ensureWorktree(h.ctx, 'task-2')
    expect(other.directory).not.toBe(first.directory)
    expect(h.ctx.ownedWorktrees.size).toBe(2)
  })

  it('创建即登记到 ownedWorktrees，释放后同时清索引', async () => {
    const h = makeHostHarness(tmp)
    const handle = await ensureWorktree(h.ctx, 'task-x')
    expect(h.ctx.ownedWorktrees.has(handle.directory)).toBe(true)

    await releaseWorktree(h.ctx, handle.directory)
    expect(h.ctx.ownedWorktrees.size).toBe(0)
    expect(h.ctx.worktreeKeys.size).toBe(0)
    expect(existsSync(handle.directory)).toBe(false)
  })

  it('底层删除失败时保留 ownership，允许终态清理重试', async () => {
    const h = makeHostHarness(tmp)
    const handle = await ensureWorktree(h.ctx, 'retry-cleanup')
    vi.spyOn(Worktree, 'remove').mockRejectedValueOnce(new Error('busy'))

    await expect(releaseWorktree(h.ctx, handle.directory)).resolves.toBe(false)
    expect(h.ctx.ownedWorktrees.has(handle.directory)).toBe(true)
    expect(h.ctx.worktreeKeys.get(handle.key)).toBe(handle.directory)
    expect(existsSync(handle.directory)).toBe(true)

    await expect(releaseWorktree(h.ctx, handle.directory)).resolves.toBe(true)
    expect(h.ctx.ownedWorktrees.has(handle.directory)).toBe(false)
    expect(h.ctx.worktreeKeys.has(handle.key)).toBe(false)
    expect(existsSync(handle.directory)).toBe(false)
  })

  it('scope 关闭后拒绝创建 worktree', async () => {
    const h = makeHostHarness(tmp)
    await h.scope.close('cancelled')
    await expect(ensureWorktree(h.ctx, 'task-late')).rejects.toThrow(/TaskScope closed/)
  })

  it('无改动的 worktree 判为 pristine 并直接回收', async () => {
    const h = makeHostHarness(tmp)
    const agent = countingAgent('unused')
    const integrate = createIntegrateFn(h.ctx, agent.fn)
    const handle = await ensureWorktree(h.ctx, 'pristine-task')

    await expect(integrate(handle.directory)).resolves.toEqual({ status: 'pristine' })
    expect(existsSync(handle.directory)).toBe(false)
    expect(agent.calls).toHaveLength(0)
  })

  it('有改动时 fast-forward 合并回主工作区，无需 agent', async () => {
    const h = makeHostHarness(tmp)
    const agent = countingAgent('unused')
    const integrate = createIntegrateFn(h.ctx, agent.fn)
    const handle = await ensureWorktree(h.ctx, 'ff-task')
    writeFileSync(join(handle.directory, 'feature.txt'), 'from worktree\n', 'utf-8')

    const result = await integrate(handle.directory)
    expect(result.status).toBe('merged')
    expect(result.status === 'merged' && result.strategy).toBe('fast-forward')
    expect(readFileSync(join(tmp, 'feature.txt'), 'utf-8')).toContain('from worktree')
    expect(existsSync(handle.directory)).toBe(false)
    expect(agent.calls).toHaveLength(0)
  })

  it('主分支已前进但无冲突时走 3-way 合并', async () => {
    const h = makeHostHarness(tmp)
    const agent = countingAgent('unused')
    const integrate = createIntegrateFn(h.ctx, agent.fn)
    const handle = await ensureWorktree(h.ctx, 'three-way-task')
    writeFileSync(join(handle.directory, 'feature.txt'), 'worktree side\n', 'utf-8')

    // 主工作区在另一个文件上先提交，制造分叉
    writeFileSync(join(tmp, 'main-only.txt'), 'main side\n', 'utf-8')
    git(['add', 'main-only.txt'], tmp)
    git(['commit', '-m', 'main advance'], tmp)

    const result = await integrate(handle.directory)
    expect(result.status).toBe('merged')
    expect(result.status === 'merged' && result.strategy).toBe('three-way')
    expect(existsSync(join(tmp, 'feature.txt'))).toBe(true)
    expect(existsSync(join(tmp, 'main-only.txt'))).toBe(true)
    expect(agent.calls).toHaveLength(0)
  })

  it('冲突且 agent 未解决时返回 conflict，保留现场与 worktree', async () => {
    const h = makeHostHarness(tmp)
    // agent 返回 null（失败）：冲突未解决
    const agent = countingAgent(null)
    const integrate = createIntegrateFn(h.ctx, agent.fn)
    const handle = await ensureWorktree(h.ctx, 'conflict-task')
    writeFileSync(join(handle.directory, 'shared.txt'), 'worktree version\n', 'utf-8')

    // 主分支改同一文件并提交 → 必然冲突
    writeFileSync(join(tmp, 'shared.txt'), 'main version\n', 'utf-8')
    git(['add', 'shared.txt'], tmp)
    git(['commit', '-m', 'main writes shared'], tmp)

    const result = await integrate(handle.directory)
    expect(result.status).toBe('conflict')
    expect(result.status === 'conflict' && result.files).toContain('shared.txt')
    // 冲突现场必须保留：worktree 不删，合并未提交
    expect(existsSync(handle.directory)).toBe(true)
    expect(agent.calls).toHaveLength(1)
    expect(agent.calls[0]).toContain('shared.txt')
  })

  it('冲突被 agent 解决后返回 merged(agent) 并回收 worktree', async () => {
    const h = makeHostHarness(tmp)
    const handle = await ensureWorktree(h.ctx, 'resolved-task')
    writeFileSync(join(handle.directory, 'shared.txt'), 'worktree version\n', 'utf-8')
    writeFileSync(join(tmp, 'shared.txt'), 'main version\n', 'utf-8')
    git(['add', 'shared.txt'], tmp)
    git(['commit', '-m', 'main writes shared'], tmp)

    // 模拟 integrate agent：解决冲突并完成合并提交
    const integrate = createIntegrateFn(h.ctx, async () => {
      writeFileSync(join(tmp, 'shared.txt'), 'merged version\n', 'utf-8')
      git(['add', 'shared.txt'], tmp)
      git(['commit', '--no-edit'], tmp)
      return 'resolved'
    })

    const result = await integrate(handle.directory)
    expect(result.status).toBe('merged')
    expect(result.status === 'merged' && result.strategy).toBe('agent')
    expect(readFileSync(join(tmp, 'shared.txt'), 'utf-8')).toContain('merged version')
    expect(existsSync(handle.directory)).toBe(false)
  })

  it('未知目录返回 failed，不抛异常', async () => {
    const h = makeHostHarness(tmp)
    const integrate = createIntegrateFn(h.ctx, countingAgent('x').fn)
    await expect(integrate(join(tmp, 'not-a-worktree'))).resolves.toEqual({
      status: 'failed',
      reason: expect.stringContaining('未知或已消失')
    })
  })

  it('scope 关闭后 integrate 返回 failed 而不动 git', async () => {
    const h = makeHostHarness(tmp)
    const handle = await ensureWorktree(h.ctx, 'late-task')
    writeFileSync(join(handle.directory, 'x.txt'), 'x', 'utf-8')
    const integrate = createIntegrateFn(h.ctx, countingAgent('x').fn)
    await h.scope.close('cancelled')

    await expect(integrate(handle.directory)).resolves.toEqual({
      status: 'failed',
      reason: 'scope closed'
    })
    expect(existsSync(join(tmp, 'x.txt'))).toBe(false)
  })

  it('合并成功后写下 committed integrate 凭证（resume 据此跳过重复合并）', async () => {
    const h = makeHostHarness(tmp)
    const integrate = createIntegrateFn(h.ctx, countingAgent('x').fn)
    const handle = await ensureWorktree(h.ctx, 'idempotent-task')
    writeFileSync(join(handle.directory, 'once.txt'), 'once\n', 'utf-8')

    const first = await integrate(handle.directory)
    expect(first.status).toBe('merged')

    const stepCtx = hostEffectCtx(h.ctx.runId, `integrate:${handle.branch}`)
    const receipt = tryReuseIntegrateReceipt({ workspaceRoot: tmp, stepCtx })
    expect(receipt?.status).toBe('committed')
    expect(receipt?.worktreeDirectory).toBe(handle.directory)

    // 同一 worktree 元数据重放（resume）：命中凭证直接返回 merged，不再动 git
    h.ctx.ownedWorktrees.set(handle.directory, {
      info: { name: handle.name, branch: handle.branch, directory: handle.directory },
      baseSha: handle.baseSha
    })
    mkdirSync(handle.directory, { recursive: true })
    const replay = await integrate(handle.directory)
    expect(replay.status).toBe('merged')
  })
})

describe('host worktreeFn 与 agent 组合', () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'nova-host-wt-agent-'))
    Worktree._resetWorktreeLocksForTests()
    initRepo(tmp)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    Worktree._resetWorktreeLocksForTests()
    rmSync(tmp, { recursive: true, force: true })
  })

  it('isolation=worktree 且 agent 无产出时删除 worktree（失败不留垃圾）', async () => {
    const { createAgentFn } = await import('../../../../../src/runtime/workflow/host/agentFn')
    const h = makeHostHarness(tmp)
    // 无预设响应 → 无产出 → null
    const agent = createAgentFn(h.ctx)

    await expect(
      agent('实现任务', { isolation: 'worktree', worktreeKey: 'impl-1' })
    ).resolves.toBeNull()
    expect(h.ctx.ownedWorktrees.size).toBe(0)
  })

  it('isolation=worktree 且 agent 未改动任何文件时删除 pristine worktree', async () => {
    const { createAgentFn } = await import('../../../../../src/runtime/workflow/host/agentFn')
    const h = makeHostHarness(tmp)
    addTextResponse(h.client, '什么都没改')
    const agent = createAgentFn(h.ctx)

    await expect(
      agent('看一眼就好', { isolation: 'worktree', worktreeKey: 'impl-2' })
    ).resolves.toBe('什么都没改')
    expect(h.ctx.ownedWorktrees.size).toBe(0)
  })
})
