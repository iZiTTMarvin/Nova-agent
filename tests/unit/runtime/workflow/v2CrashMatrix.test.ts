/**
 * Workflow v2 副作用崩溃注入恢复矩阵。
 * 用 setFaultInjector 模拟 prepared/execute/receipt/step-commit 各点崩溃，
 * 验证 resume 后：幂等可补提交、非幂等 blocked、副作用不重复执行。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { EventBus } from '../../../../src/runtime/agent/EventBus'
import { MockModelClient } from '../../../../src/test-support/builders/MockModelClient'
import { TaskScope } from '../../../../src/runtime/workflow/TaskScope'
import { createHostHooks, type HookContext } from '../../../../src/runtime/workflow/hooks'
import { makeRunSemaphore } from '../../../../src/runtime/workflow/semaphore'
import { createInitialState } from '../../../../src/runtime/workflow/state'
import { StepEngine } from '../../../../src/runtime/workflow/v2/StepEngine'
import { readStepRecord } from '../../../../src/runtime/workflow/v2/stepStore'
import {
  setFaultInjector,
  effectIdFromKey
} from '../../../../src/runtime/workflow/v2/sideEffectCtx'
import { readFileEffect } from '../../../../src/runtime/workflow/v2/EffectReceipt'
import { readBashReceipt, bashEffectId, hashCommand } from '../../../../src/runtime/workflow/v2/BashReceipt'
import type { WorkflowRuntimeDeps } from '../../../../src/runtime/workflow/types'

function makeHooks(workspaceRoot: string, runId: string): {
  hooks: ReturnType<typeof createHostHooks>
  scope: TaskScope
  hookCtx: HookContext
} {
  const scope = new TaskScope({ label: 'crash-matrix' })
  const { runSem, globalSem } = makeRunSemaphore(2)
  const deps: WorkflowRuntimeDeps = {
    modelClient: new MockModelClient(),
    parentEventBus: new EventBus(),
    resolveTool: () => undefined,
    workspaceRoot,
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
      scriptName: 'crash',
      startedAt: new Date().toISOString()
    }),
    pendingAskUsers: new Map(),
    persistState: () => undefined
  }
  return { hooks: createHostHooks(hookCtx), scope, hookCtx }
}

describe('v2 副作用崩溃注入恢复矩阵', () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'nova-crash-mx-'))
    setFaultInjector(null)
  })

  afterEach(async () => {
    setFaultInjector(null)
    rmSync(tmp, { recursive: true, force: true })
  })

  it('write：after-receipt 后、before-step-commit 前崩溃 → resume 补提交 step，不重复写', async () => {
    const runId = 'crash-write-1'
    let writeCount = 0
    const path = 'out/a.txt'
    const body = 'hello-crash\n'

    // 第一次：注入 before-step-commit
    {
      const { hooks, scope } = makeHooks(tmp, runId)
      const engine = new StepEngine({
        workspaceRoot: tmp,
        runId,
        workflowName: 'crash',
        scriptSha: 'sha1',
        scope
      })
      setFaultInjector((stepId, point) => {
        if (stepId === 'write:a' && point === 'before-step-commit') {
          throw new Error('injected-crash-before-step-commit')
        }
      })
      engine.register({
        id: 'write:a',
        kind: 'write',
        policy: { retryable: true, sideEffect: 'fs' },
        input: { path, body },
        run: async (sc) => {
          writeCount++
          await hooks.write!(path, body, sc)
          return { path }
        }
      })
      const r = await engine.runAll()
      expect(r.status).toBe('failed')
      expect(readStepRecord(tmp, runId, 'write:a')?.status).toBe('failed')
      // 文件与 effect receipt 应已落盘
      expect(readFileSync(join(tmp, path), 'utf-8')).toBe(body)
      const effectId = effectIdFromKey(
        `${readStepRecord(tmp, runId, 'write:a')!.idempotencyKey}:write`
      )
      expect(readFileEffect(tmp, runId, effectId)?.status).toBe('committed')
      await scope.close('failed')
    }

    setFaultInjector(null)
    writeCount = 0

    // resume：step 失败可重试；write 应跳过实际写入
    {
      const { hooks, scope } = makeHooks(tmp, runId)
      const engine = new StepEngine({
        workspaceRoot: tmp,
        runId,
        workflowName: 'crash',
        scriptSha: 'sha1',
        scope
      })
      engine.register({
        id: 'write:a',
        kind: 'write',
        policy: { retryable: true, sideEffect: 'fs' },
        input: { path, body },
        run: async (sc) => {
          writeCount++
          const out = await hooks.write!(path, body, sc)
          return { path, out }
        }
      })
      const r = await engine.runAll()
      expect(r.status).toBe('completed')
      expect(readStepRecord(tmp, runId, 'write:a')?.status).toBe('committed')
      expect(writeCount).toBe(1)
      const out = engine.getOutput<{ out?: { reused?: boolean } }>('write:a')
      expect(out?.out?.reused).toBe(true)
      await scope.close('completed')
    }
  })

  it('write：after-prepared 崩溃 → resume 可完成（文件未写或补写）', async () => {
    const runId = 'crash-write-prep'
    const path = 'out/b.txt'
    const body = 'prepared-crash\n'
    {
      const { hooks, scope } = makeHooks(tmp, runId)
      const engine = new StepEngine({
        workspaceRoot: tmp,
        runId,
        workflowName: 'crash',
        scriptSha: 'sha1',
        scope
      })
      setFaultInjector((stepId, point) => {
        if (stepId === 'write:b' && point === 'after-prepared') {
          throw new Error('injected-after-prepared')
        }
      })
      engine.register({
        id: 'write:b',
        kind: 'write',
        policy: { retryable: true, sideEffect: 'fs' },
        input: { path, body },
        run: async (sc) => {
          await hooks.write!(path, body, sc)
          return { path }
        }
      })
      expect((await engine.runAll()).status).toBe('failed')
      await scope.close('failed')
    }
    setFaultInjector(null)
    {
      const { hooks, scope } = makeHooks(tmp, runId)
      const engine = new StepEngine({
        workspaceRoot: tmp,
        runId,
        workflowName: 'crash',
        scriptSha: 'sha1',
        scope
      })
      engine.register({
        id: 'write:b',
        kind: 'write',
        policy: { retryable: true, sideEffect: 'fs' },
        input: { path, body },
        run: async (sc) => {
          await hooks.write!(path, body, sc)
          return { path }
        }
      })
      expect((await engine.runAll()).status).toBe('completed')
      expect(readFileSync(join(tmp, path), 'utf-8')).toBe(body)
      await scope.close('completed')
    }
  })

  it('幂等 bash：after-receipt 后崩溃 → resume 复用 receipt', async () => {
    const runId = 'crash-bash-idemp'
    const cmd = 'node -e "process.stdout.write(\'bash-ok\')"'
    let execPasses = 0
    {
      const { hooks, scope } = makeHooks(tmp, runId)
      const engine = new StepEngine({
        workspaceRoot: tmp,
        runId,
        workflowName: 'crash',
        scriptSha: 'sha1',
        scope
      })
      setFaultInjector((stepId, point) => {
        if (stepId === 'bash:ok' && point === 'before-step-commit') {
          throw new Error('injected-bash-commit')
        }
      })
      engine.register({
        id: 'bash:ok',
        kind: 'bash',
        policy: { retryable: true, sideEffect: 'bash', idempotent: true },
        input: { cmd },
        run: async (sc) => {
          execPasses++
          return hooks.bash!(cmd, sc)
        }
      })
      expect((await engine.runAll()).status).toBe('failed')
      const rec = readStepRecord(tmp, runId, 'bash:ok')!
      const eid = bashEffectId(
        {
          runId,
          stepId: 'bash:ok',
          inputHash: rec.inputHash,
          idempotencyKey: rec.idempotencyKey
        },
        hashCommand(cmd)
      )
      expect(readBashReceipt(tmp, runId, eid)?.status).toBe('committed')
      await scope.close('failed')
    }
    setFaultInjector(null)
    execPasses = 0
    {
      const { hooks, scope } = makeHooks(tmp, runId)
      const engine = new StepEngine({
        workspaceRoot: tmp,
        runId,
        workflowName: 'crash',
        scriptSha: 'sha1',
        scope
      })
      engine.register({
        id: 'bash:ok',
        kind: 'bash',
        policy: { retryable: true, sideEffect: 'bash', idempotent: true },
        input: { cmd },
        run: async (sc) => {
          execPasses++
          const r = (await hooks.bash!(cmd, sc)) as { reused?: boolean }
          return r
        }
      })
      expect((await engine.runAll()).status).toBe('completed')
      expect(engine.getOutput<{ reused?: boolean }>('bash:ok')?.reused).toBe(true)
      await scope.close('completed')
    }
  })

  it('非幂等 bash：prepared 后崩溃 → resume blocked，不重跑', async () => {
    const runId = 'crash-bash-non'
    const cmd = 'node -e "process.stdout.write(\'boom\')"'
    let calls = 0
    {
      const { hooks, scope } = makeHooks(tmp, runId)
      const engine = new StepEngine({
        workspaceRoot: tmp,
        runId,
        workflowName: 'crash',
        scriptSha: 'sha1',
        scope
      })
      setFaultInjector((stepId, point) => {
        if (stepId === 'bash:non' && point === 'after-prepared') {
          throw new Error('injected-after-prepared-bash')
        }
      })
      engine.register({
        id: 'bash:non',
        kind: 'bash',
        policy: { retryable: true, sideEffect: 'bash', idempotent: false },
        input: { cmd },
        run: async (sc) => {
          calls++
          return hooks.bash!(cmd, sc)
        }
      })
      expect((await engine.runAll()).status).toBe('failed')
      expect(readStepRecord(tmp, runId, 'bash:non')?.status).toBe('failed')
      await scope.close('failed')
    }
    setFaultInjector(null)
    calls = 0
    {
      const { hooks, scope } = makeHooks(tmp, runId)
      const engine = new StepEngine({
        workspaceRoot: tmp,
        runId,
        workflowName: 'crash',
        scriptSha: 'sha1',
        scope
      })
      engine.register({
        id: 'bash:non',
        kind: 'bash',
        policy: { retryable: true, sideEffect: 'bash', idempotent: false },
        input: { cmd },
        run: async (sc) => {
          calls++
          return hooks.bash!(cmd, sc)
        }
      })
      const r = await engine.runAll()
      expect(r.status).toBe('failed')
      expect(String(r.error ?? '')).toMatch(/禁止自动重跑|SIDE_EFFECT_BLOCKED|非幂等/)
      expect(calls).toBe(1)
      await scope.close('failed')
    }
  })

  it('committed + inputHash 匹配 → 跳过；scriptSha 改变 → reject', async () => {
    const runId = 'crash-skip'
    const { hooks, scope } = makeHooks(tmp, runId)
    const engine = new StepEngine({
      workspaceRoot: tmp,
      runId,
      workflowName: 'crash',
      scriptSha: 'sha-a',
      scope
    })
    let n = 0
    engine.register({
      id: 's1',
      kind: 'custom',
      input: { x: 1 },
      policy: { retryable: true, sideEffect: 'none' },
      run: async () => {
        n++
        return { ok: true }
      }
    })
    expect((await engine.runAll()).status).toBe('completed')
    expect(n).toBe(1)
    await scope.close('completed')

    const scope2 = new TaskScope({ label: 'resume-skip' })
    const engine2 = new StepEngine({
      workspaceRoot: tmp,
      runId,
      workflowName: 'crash',
      scriptSha: 'sha-a',
      scope: scope2
    })
    engine2.register({
      id: 's1',
      kind: 'custom',
      input: { x: 1 },
      policy: { retryable: true },
      run: async () => {
        n++
        return { ok: true }
      }
    })
    expect((await engine2.runAll()).status).toBe('completed')
    expect(n).toBe(1) // 未再执行
    await scope2.close('completed')

    const scope3 = new TaskScope({ label: 'sha-mismatch' })
    expect(
      () =>
        new StepEngine({
          workspaceRoot: tmp,
          runId,
          workflowName: 'crash',
          scriptSha: 'sha-b',
          scope: scope3
        })
    ).toThrow(/script source changed/)
    await scope3.close('cancelled')
  })

  it('delete host fn：prepared→delete→committed，rollback 可恢复', async () => {
    const runId = 'del-1'
    const { hooks, scope } = makeHooks(tmp, runId)
    const rel = 'to-delete.txt'
    writeFileSync(join(tmp, rel), 'keep-me\n')
    const sc = {
      runId,
      stepId: 'del:1',
      inputHash: 'h',
      idempotencyKey: `${runId}:del:1:h`,
      policy: { sideEffect: 'fs' as const, retryable: true },
      resumingInterrupted: false
    }
    await hooks.delete!(rel, sc)
    expect(existsSync(join(tmp, rel))).toBe(false)
    const effectId = effectIdFromKey(`${sc.idempotencyKey}:delete`)
    expect(readFileEffect(tmp, runId, effectId)?.action).toBe('delete')
    expect(readFileEffect(tmp, runId, effectId)?.status).toBe('committed')

    const { confirmRollback, previewRollback } = await import(
      '../../../../src/runtime/workflow/v2/EffectReceipt'
    )
    const preview = previewRollback(tmp, runId)
    const result = confirmRollback(tmp, runId, { previewToken: preview.previewToken })
    expect(result.ok).toBe(true)
    expect(readFileSync(join(tmp, rel), 'utf-8')).toBe('keep-me\n')
    await scope.close('completed')
  })
})
