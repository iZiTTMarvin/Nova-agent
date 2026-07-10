/**
 * worktree / integrate 副作用 receipt 与对账
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { spawnSync } from 'child_process'
import {
  commitWorktreeReceipt,
  tryReuseWorktreeReceipt,
  markWorktreeCleaned,
  readWorktreeReceipt,
  worktreeEffectId
} from '../../../../src/runtime/workflow/v2/WorktreeReceipt'
import {
  commitIntegrateReceipt,
  tryReuseIntegrateReceipt,
  integrateEffectId
} from '../../../../src/runtime/workflow/v2/IntegrateReceipt'
import { SideEffectBlockedError } from '../../../../src/runtime/workflow/v2/sideEffectCtx'
import type { SideEffectCtx } from '../../../../src/runtime/workflow/v2/sideEffectCtx'
import { EventBus } from '../../../../src/runtime/agent/EventBus'
import { MockModelClient } from '../../../../src/test-support/builders/MockModelClient'
import { TaskScope } from '../../../../src/runtime/workflow/TaskScope'
import { createHostHooks, type HookContext } from '../../../../src/runtime/workflow/hooks'
import { makeRunSemaphore } from '../../../../src/runtime/workflow/semaphore'
import { createInitialState } from '../../../../src/runtime/workflow/state'
import type { WorkflowRuntimeDeps } from '../../../../src/runtime/workflow/types'

function git(cwd: string, args: string[]): void {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8', windowsHide: true })
  if (r.status !== 0) throw new Error(r.stderr || r.stdout || args.join(' '))
}

function makeStepCtx(runId: string, overrides: Partial<SideEffectCtx> = {}): SideEffectCtx {
  return {
    runId,
    stepId: 'execute:t1:impl',
    inputHash: 'hash1',
    idempotencyKey: `${runId}:execute:t1:impl:hash1`,
    policy: { retryable: true, sideEffect: 'worktree' },
    resumingInterrupted: false,
    ...overrides
  }
}

describe('v2 WorktreeReceipt', () => {
  let tmp: string
  const runId = 'wt-run-1'

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'nova-wt-rcpt-'))
    git(tmp, ['init'])
    git(tmp, ['config', 'user.email', 'test@nova.local'])
    git(tmp, ['config', 'user.name', 'nova-test'])
    writeFileSync(join(tmp, 'README.md'), '# init\n')
    git(tmp, ['add', '.'])
    git(tmp, ['commit', '-m', 'init'])
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it('worktree step resume 时目录仍存在 → 复用，不重建', () => {
    const sc = makeStepCtx(runId)
    const dir = join(tmp, '.nova-worktrees', 'reuse-me')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'marker.txt'), 'x')

    commitWorktreeReceipt({
      workspaceRoot: tmp,
      stepCtx: sc,
      directory: dir,
      branch: 'nova/reuse-me',
      baseSha: 'abc123'
    })

    const reused = tryReuseWorktreeReceipt({ workspaceRoot: tmp, stepCtx: sc })
    expect(reused).not.toBeNull()
    expect(reused!.directory).toBe(dir)
    expect(reused!.branch).toBe('nova/reuse-me')
    expect(reused!.baseSha).toBe('abc123')
  })

  it('目录被外部删除 → retryable 可重建；非 retryable blocked', async () => {
    const scRetry = makeStepCtx(runId, {
      policy: { retryable: true, sideEffect: 'worktree' }
    })
    const gone = join(tmp, 'gone-wt')
    commitWorktreeReceipt({
      workspaceRoot: tmp,
      stepCtx: scRetry,
      directory: gone,
      branch: 'nova/gone',
      baseSha: 'dead'
    })
    // 目录不存在 → tryReuse 返回 null（调用方按 retryable 重建）
    expect(tryReuseWorktreeReceipt({ workspaceRoot: tmp, stepCtx: scRetry })).toBeNull()

    // 非 retryable + 中断：通过 host hook 验证 blocked
    const scope = new TaskScope({ label: 'wt-block' })
    const { runSem, globalSem } = makeRunSemaphore(1)
    const deps: WorkflowRuntimeDeps = {
      modelClient: new MockModelClient(),
      parentEventBus: new EventBus(),
      resolveTool: () => undefined,
      workspaceRoot: tmp,
      mode: 'compose'
    }
    const hookCtx: HookContext = {
      runId,
      deps,
      abortSignal: scope.signal,
      scope,
      scopeGeneration: scope.captureGeneration(),
      currentPhase: { name: '' },
      onPhase: () => undefined,
      onLog: () => undefined,
      journal: { results: new Map(), pass: 0 },
      occ: new Map(),
      runSem,
      globalSem,
      ownedWorktrees: new Map(),
      composeState: createInitialState({
        runId,
        scriptName: 't',
        startedAt: new Date().toISOString()
      }),
      pendingAskUsers: new Map(),
      persistState: () => undefined
    }
    const hooks = createHostHooks(hookCtx)
    const scBlock = makeStepCtx(runId + '-nr', {
      stepId: 'execute:t2:impl',
      idempotencyKey: `${runId}-nr:execute:t2:impl:h`,
      policy: { retryable: false, sideEffect: 'worktree' },
      resumingInterrupted: true
    })
    // 写一条目录已删的 receipt
    commitWorktreeReceipt({
      workspaceRoot: tmp,
      stepCtx: scBlock,
      directory: join(tmp, 'missing-nr'),
      branch: 'nova/nr',
      baseSha: 'x'
    })

    await expect(
      hooks.agent!('impl', {
        isolation: 'worktree',
        label: 't2',
        stepCtx: scBlock
      })
    ).rejects.toBeInstanceOf(SideEffectBlockedError)

    await scope.close('completed')
  })

  it('integrate 后 cleanup 标记 receipt cleaned', () => {
    const sc = makeStepCtx(runId)
    const dir = join(tmp, 'wt-clean')
    mkdirSync(dir, { recursive: true })
    commitWorktreeReceipt({
      workspaceRoot: tmp,
      stepCtx: sc,
      directory: dir,
      branch: 'nova/c',
      baseSha: 'b'
    })
    const marked = markWorktreeCleaned(tmp, runId, { stepCtx: sc })
    expect(marked?.status).toBe('cleaned')
    expect(readWorktreeReceipt(tmp, runId, worktreeEffectId(sc))?.status).toBe('cleaned')
  })
})

describe('v2 IntegrateReceipt', () => {
  let tmp: string
  const runId = 'ig-run-1'

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'nova-ig-rcpt-'))
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it('integrate resume 时已 committed → 跳过', async () => {
    const sc: SideEffectCtx = {
      runId,
      stepId: 'execute:t1:integrate',
      inputHash: 'h',
      idempotencyKey: `${runId}:execute:t1:integrate:h`,
      policy: { sideEffect: 'integrate', retryable: false },
      resumingInterrupted: false
    }
    commitIntegrateReceipt({
      workspaceRoot: tmp,
      stepCtx: sc,
      worktreeDirectory: '/fake/wt',
      result: { ok: true }
    })
    expect(tryReuseIntegrateReceipt({ workspaceRoot: tmp, stepCtx: sc })?.status).toBe(
      'committed'
    )

    const scope = new TaskScope({ label: 'ig' })
    const { runSem, globalSem } = makeRunSemaphore(1)
    const deps: WorkflowRuntimeDeps = {
      modelClient: new MockModelClient(),
      parentEventBus: new EventBus(),
      resolveTool: () => undefined,
      workspaceRoot: tmp,
      mode: 'compose'
    }
    const hookCtx: HookContext = {
      runId,
      deps,
      abortSignal: scope.signal,
      scope,
      scopeGeneration: scope.captureGeneration(),
      currentPhase: { name: '' },
      onPhase: () => undefined,
      onLog: () => undefined,
      journal: { results: new Map(), pass: 0 },
      occ: new Map(),
      runSem,
      globalSem,
      ownedWorktrees: new Map(),
      composeState: createInitialState({
        runId,
        scriptName: 't',
        startedAt: new Date().toISOString()
      }),
      pendingAskUsers: new Map(),
      persistState: () => undefined
    }
    const hooks = createHostHooks(hookCtx)
    const out = (await hooks.integrate!(
      '执行 integrate：合并',
      { schema: { type: 'object' }, stepCtx: sc },
      sc
    )) as { skipped?: boolean; reused?: boolean }
    expect(out.skipped).toBe(true)
    expect(out.reused).toBe(true)
    await scope.close('completed')
  })

  it('integrate 前崩溃（无 receipt）→ 正常执行路径可进入 agent', async () => {
    const sc: SideEffectCtx = {
      runId,
      stepId: 'execute:t1:integrate',
      inputHash: 'h2',
      idempotencyKey: `${runId}:execute:t1:integrate:h2`,
      policy: { sideEffect: 'integrate', retryable: false },
      resumingInterrupted: false
    }
    expect(tryReuseIntegrateReceipt({ workspaceRoot: tmp, stepCtx: sc })).toBeNull()
    expect(existsSync(join(tmp, '.nova', 'compose', 'runs', runId, 'integrate-receipts'))).toBe(
      false
    )
    // effectId 稳定可预测
    expect(integrateEffectId(sc)).toContain('integrate')
  })

  it('中断恢复无 receipt → blocked', async () => {
    const sc: SideEffectCtx = {
      runId,
      stepId: 'execute:t1:integrate',
      inputHash: 'h3',
      idempotencyKey: `${runId}:execute:t1:integrate:h3`,
      policy: { sideEffect: 'integrate', retryable: false },
      resumingInterrupted: true
    }
    const scope = new TaskScope({ label: 'ig-block' })
    const { runSem, globalSem } = makeRunSemaphore(1)
    const deps: WorkflowRuntimeDeps = {
      modelClient: new MockModelClient(),
      parentEventBus: new EventBus(),
      resolveTool: () => undefined,
      workspaceRoot: tmp,
      mode: 'compose'
    }
    const hookCtx: HookContext = {
      runId,
      deps,
      abortSignal: scope.signal,
      scope,
      scopeGeneration: scope.captureGeneration(),
      currentPhase: { name: '' },
      onPhase: () => undefined,
      onLog: () => undefined,
      journal: { results: new Map(), pass: 0 },
      occ: new Map(),
      runSem,
      globalSem,
      ownedWorktrees: new Map(),
      composeState: createInitialState({
        runId,
        scriptName: 't',
        startedAt: new Date().toISOString()
      }),
      pendingAskUsers: new Map(),
      persistState: () => undefined
    }
    const hooks = createHostHooks(hookCtx)
    await expect(hooks.integrate!('执行 integrate', {}, sc)).rejects.toBeInstanceOf(
      SideEffectBlockedError
    )
    await scope.close('completed')
  })
})
