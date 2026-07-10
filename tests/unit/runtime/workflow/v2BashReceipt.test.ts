/**
 * bash 副作用 receipt：幂等复用 / 非幂等 blocked / commandHash 变化不复用
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { EventBus } from '../../../../src/runtime/agent/EventBus'
import { MockModelClient } from '../../../../src/test-support/builders/MockModelClient'
import { TaskScope } from '../../../../src/runtime/workflow/TaskScope'
import { createHostHooks, type HookContext } from '../../../../src/runtime/workflow/hooks'
import { makeRunSemaphore } from '../../../../src/runtime/workflow/semaphore'
import { createInitialState } from '../../../../src/runtime/workflow/state'
import {
  readBashReceipt,
  bashEffectId,
  hashCommand
} from '../../../../src/runtime/workflow/v2/BashReceipt'
import { SideEffectBlockedError } from '../../../../src/runtime/workflow/v2/sideEffectCtx'
import type { SideEffectCtx } from '../../../../src/runtime/workflow/v2/sideEffectCtx'
import type { WorkflowRuntimeDeps } from '../../../../src/runtime/workflow/types'

function makeHookCtx(workspaceRoot: string, runId: string): HookContext {
  const scope = new TaskScope({ label: 'bash-receipt-test' })
  const { runSem, globalSem } = makeRunSemaphore(2)
  const composeState = createInitialState({
    runId,
    scriptName: 'test',
    startedAt: new Date().toISOString()
  })
  const deps: WorkflowRuntimeDeps = {
    modelClient: new MockModelClient(),
    parentEventBus: new EventBus(),
    resolveTool: () => undefined,
    workspaceRoot,
    mode: 'compose'
  }
  return {
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
    composeState,
    pendingAskUsers: new Map(),
    persistState: () => undefined
  }
}

function makeStepCtx(
  runId: string,
  overrides: Partial<SideEffectCtx> = {}
): SideEffectCtx {
  return {
    runId,
    stepId: 'bash:test',
    inputHash: 'abc',
    idempotencyKey: `${runId}:bash:test:abc`,
    policy: { retryable: true, sideEffect: 'bash', idempotent: true },
    resumingInterrupted: false,
    ...overrides
  }
}

describe('v2 BashReceipt', () => {
  let tmp: string
  let hookCtx: HookContext
  const runId = 'bash-run-1'

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'nova-bash-rcpt-'))
    hookCtx = makeHookCtx(tmp, runId)
  })

  afterEach(async () => {
    await hookCtx.scope.close('completed')
    rmSync(tmp, { recursive: true, force: true })
  })

  it('幂等 bash resume 复用结果，不重复执行', async () => {
    const hooks = createHostHooks(hookCtx)
    const sc = makeStepCtx(runId, {
      policy: { idempotent: true, sideEffect: 'bash', retryable: true }
    })

    // 第一次：真实执行（echo 在 Windows 可能不同，用 git --version 或简单命令）
    // 用 node -e 保证跨平台
    const cmd = 'node -e "process.stdout.write(\'ok-once\')"'
    const r1 = (await hooks.bash!(cmd, sc)) as {
      exitCode: number
      stdout: string
      passed: boolean
      reused?: boolean
    }
    expect(r1.passed).toBe(true)
    expect(r1.reused).toBeFalsy()

    const effectId = bashEffectId(sc, hashCommand(cmd))
    expect(existsSync(join(tmp, '.nova', 'compose', 'runs', runId, 'bash-receipts', `${effectId}.json`))).toBe(
      true
    )
    const receipt = readBashReceipt(tmp, runId, effectId)
    expect(receipt?.status).toBe('committed')
    expect(receipt?.exitCode).toBe(0)

    // 第二次：应复用，不真正再跑（stdout 为 preview）
    const r2 = (await hooks.bash!(cmd, sc)) as {
      exitCode: number
      passed: boolean
      reused?: boolean
    }
    expect(r2.reused).toBe(true)
    expect(r2.passed).toBe(true)
    expect(r2.exitCode).toBe(0)
  })

  it('非幂等 bash resume → blocked，不自动重跑', async () => {
    const hooks = createHostHooks(hookCtx)
    const sc = makeStepCtx(runId, {
      policy: { idempotent: false, sideEffect: 'bash', retryable: true },
      resumingInterrupted: true
    })
    const cmd = 'node -e "process.stdout.write(\'side-effect\')"'

    await expect(hooks.bash!(cmd, sc)).rejects.toBeInstanceOf(SideEffectBlockedError)
  })

  it('commandHash 变化（命令改了）→ 不复用旧 receipt', async () => {
    const hooks = createHostHooks(hookCtx)
    const sc = makeStepCtx(runId, {
      policy: { idempotent: true, sideEffect: 'bash', retryable: true }
    })
    const cmd1 = 'node -e "process.stdout.write(\'v1\')"'
    const cmd2 = 'node -e "process.stdout.write(\'v2\')"'

    const r1 = (await hooks.bash!(cmd1, sc)) as { reused?: boolean; passed: boolean }
    expect(r1.passed).toBe(true)
    expect(r1.reused).toBeFalsy()

    const r2 = (await hooks.bash!(cmd2, sc)) as { reused?: boolean; passed: boolean; stdout: string }
    expect(r2.reused).toBeFalsy()
    expect(r2.passed).toBe(true)
    expect(r2.stdout).toContain('v2')

    // 两条 receipt 都应存在
    const id1 = bashEffectId(sc, hashCommand(cmd1))
    const id2 = bashEffectId(sc, hashCommand(cmd2))
    expect(id1).not.toBe(id2)
    expect(readBashReceipt(tmp, runId, id1)?.status).toBe('committed')
    expect(readBashReceipt(tmp, runId, id2)?.status).toBe('committed')
  })
})
