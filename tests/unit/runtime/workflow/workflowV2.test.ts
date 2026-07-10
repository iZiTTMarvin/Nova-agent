/**
 * Compose 每 run 独立原子状态 + v2 step engine
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  createInitialState,
  readComposeState,
  writeComposeState
} from '../../../../src/runtime/workflow/state'
import {
  runStatePath,
  statePath,
  runDirV2,
  sessionCurrentPath
} from '../../../../src/runtime/workflow/paths'
import { TaskScope } from '../../../../src/runtime/workflow/TaskScope'
import { StepEngine } from '../../../../src/runtime/workflow/v2/StepEngine'
import {
  computeInputHash,
  listStepRecords,
  readStepRecord,
  writeStepRecord
} from '../../../../src/runtime/workflow/v2/stepStore'
import { buildResumePlanFromDisk } from '../../../../src/runtime/workflow/v2'
import { _resetWorkflowRuntimeForTests } from '../../../../src/runtime/workflow/runtime'

describe('compose per-run atomic state', () => {
  let tmp: string

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'nova-compose-state-'))
    await _resetWorkflowRuntimeForTests()
  })

  afterEach(async () => {
    await _resetWorkflowRuntimeForTests()
    rmSync(tmp, { recursive: true, force: true })
  })

  it('默认只写 v2 runs/<runId>/state.json，不镜像 v1', () => {
    const state = createInitialState({
      runId: 'run-a',
      scriptName: 'br-full-dev',
      startedAt: new Date().toISOString(),
      sessionId: 'sess-1'
    })
    writeComposeState(tmp, state)

    expect(existsSync(runStatePath(tmp, 'run-a'))).toBe(true)
    expect(existsSync(statePath(tmp))).toBe(false)
    expect(existsSync(sessionCurrentPath(tmp, 'sess-1'))).toBe(true)

    const fromV2 = readComposeState(tmp, 'run-a')
    expect(fromV2?.run.id).toBe('run-a')

    // 另一 run 不互相覆盖 v2 文件
    const stateB = createInitialState({
      runId: 'run-b',
      scriptName: 'smoke',
      startedAt: new Date().toISOString()
    })
    writeComposeState(tmp, stateB)
    expect(readComposeState(tmp, 'run-a')?.run.id).toBe('run-a')
    expect(readComposeState(tmp, 'run-b')?.run.id).toBe('run-b')
  })

  it('mirrorV1=true 时才写全局 state.json（engine:v1）', () => {
    const state = createInitialState({
      runId: 'run-v1',
      scriptName: 'legacy',
      startedAt: new Date().toISOString()
    })
    writeComposeState(tmp, state, { mirrorV1: true })
    expect(existsSync(runStatePath(tmp, 'run-v1'))).toBe(true)
    expect(existsSync(statePath(tmp))).toBe(true)
    expect(readComposeState(tmp)?.run.id).toBe('run-v1')
  })

  it('可读 v1 兼容路径（仅有全局 state.json）', () => {
    mkdirSync(join(tmp, '.nova', 'compose'), { recursive: true })
    const legacy = createInitialState({
      runId: 'legacy',
      scriptName: 'x',
      startedAt: new Date().toISOString()
    })
    writeFileSync(statePath(tmp), JSON.stringify(legacy), 'utf-8')
    expect(readComposeState(tmp)?.run.id).toBe('legacy')
  })
})

describe('Workflow v2 StepEngine', () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'nova-wf-v2-'))
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it('committed step 恢复时跳过，不重复执行', async () => {
    const scope = new TaskScope({ label: 'v2-test' })
    let runs = 0
    const engine = new StepEngine({
      workspaceRoot: tmp,
      runId: 'v2-1',
      workflowName: 'test',
      scriptSha: 'abc',
      scope
    })
    engine.register({
      id: 's1',
      kind: 'custom',
      input: { n: 1 },
      policy: { retryable: true },
      run: async () => {
        runs++
        return { ok: true }
      }
    })
    const r1 = await engine.runAll()
    expect(r1.status).toBe('completed')
    expect(runs).toBe(1)
    expect(readStepRecord(tmp, 'v2-1', 's1')?.status).toBe('committed')

    await scope.close('completed')

    // 新 scope resume
    const scope2 = new TaskScope({ label: 'v2-resume' })
    const engine2 = new StepEngine({
      workspaceRoot: tmp,
      runId: 'v2-1',
      workflowName: 'test',
      scriptSha: 'abc',
      scope: scope2
    })
    engine2.register({
      id: 's1',
      kind: 'custom',
      input: { n: 1 },
      policy: { retryable: true },
      run: async () => {
        runs++
        return { ok: true }
      }
    })
    const r2 = await engine2.runAll()
    expect(r2.status).toBe('completed')
    expect(runs).toBe(1) // 未再执行
    await scope2.close('completed')
  })

  it('scriptSha 不匹配默认拒绝恢复', () => {
    const scope = new TaskScope()
    const engine = new StepEngine({
      workspaceRoot: tmp,
      runId: 'v2-sha',
      workflowName: 'test',
      scriptSha: 'sha1',
      scope
    })
    engine.register({
      id: 'a',
      kind: 'custom',
      input: {},
      run: async () => 1
    })
    void engine
    void scope.close('completed')

    const scope2 = new TaskScope()
    expect(
      () =>
        new StepEngine({
          workspaceRoot: tmp,
          runId: 'v2-sha',
          workflowName: 'test',
          scriptSha: 'sha2',
          scope: scope2,
          onScriptShaMismatch: 'reject'
        })
    ).toThrow(/script source changed/)
  })

  it('inspect resume 区分 skip / run', async () => {
    const scope = new TaskScope()
    const engine = new StepEngine({
      workspaceRoot: tmp,
      runId: 'v2-plan',
      workflowName: 'test',
      scriptSha: 's',
      scope
    })
    engine.register({
      id: 'a',
      kind: 'bash',
      input: { x: 1 },
      run: async () => 'A'
    })
    engine.register({
      id: 'b',
      kind: 'agent',
      input: { x: 2 },
      deps: ['a'],
      run: async () => 'B'
    })
    // 先跑一遍：a/b 均 committed
    await engine.runAll()
    const plan = engine.planResume()
    expect(plan.skip.map((s) => s.stepId).sort()).toEqual(['a', 'b'])
    expect(plan.run.length).toBe(0)

    // 强制从 b 重跑
    const plan2 = buildResumePlanFromDisk(tmp, 'v2-plan', 'b')
    expect(plan2?.skip.map((s) => s.stepId)).toEqual(['a'])
    expect(plan2?.run.map((s) => s.stepId)).toEqual(['b'])
    expect(existsSync(runDirV2(tmp, 'v2-plan'))).toBe(true)
    expect(listStepRecords(tmp, 'v2-plan').length).toBe(2)
    // 覆盖写一条不同 hash 的记录仍可解析
    writeStepRecord(tmp, 'v2-plan', {
      stepId: 'a',
      kind: 'bash',
      inputHash: computeInputHash({ x: 1 }),
      idempotencyKey: 'k',
      status: 'committed',
      policy: { retryable: true },
      output: 'A'
    })
    expect(readStepRecord(tmp, 'v2-plan', 'a')?.output).toBe('A')
    await scope.close('completed')
  })

  it('按 deps 拓扑执行：注册顺序与依赖相反时仍先跑依赖', async () => {
    const scope = new TaskScope({ label: 'topo' })
    const order: string[] = []
    const engine = new StepEngine({
      workspaceRoot: tmp,
      runId: 'v2-topo',
      workflowName: 'test',
      scriptSha: 'topo',
      scope
    })
    // 故意先注册 child 再注册 parent
    engine.register({
      id: 'child',
      kind: 'custom',
      deps: ['parent'],
      input: { n: 2 },
      run: async () => {
        order.push('child')
        return 2
      }
    })
    engine.register({
      id: 'parent',
      kind: 'custom',
      input: { n: 1 },
      run: async () => {
        order.push('parent')
        return 1
      }
    })
    const r = await engine.runAll()
    expect(r.status).toBe('completed')
    expect(order).toEqual(['parent', 'child'])
    await scope.close('completed')
  })

  it('依赖成环时 runAll 失败', async () => {
    const scope = new TaskScope({ label: 'cycle' })
    const engine = new StepEngine({
      workspaceRoot: tmp,
      runId: 'v2-cycle',
      workflowName: 'test',
      scriptSha: 'cycle',
      scope
    })
    engine.register({
      id: 'a',
      kind: 'custom',
      deps: ['b'],
      input: {},
      run: async () => 1
    })
    engine.register({
      id: 'b',
      kind: 'custom',
      deps: ['a'],
      input: {},
      run: async () => 2
    })
    const r = await engine.runAll()
    expect(r.status).toBe('failed')
    expect(r.error).toMatch(/环/)
    await scope.close('failed')
  })
})
