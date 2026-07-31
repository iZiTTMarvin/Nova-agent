/**
 * WorkflowOrchestrator / WorkflowRun 契约测试。
 *
 * 覆盖：状态机唯一终态、取消穿透到 TaskScope、进度事件与 run 状态投影顺序、
 * worktree 生命周期（成功保留有改动 / 删 pristine，失败与取消全删）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { spawnSync } from 'child_process'
import { tmpdir } from 'os'
import { join } from 'path'
import { EventBus } from '../../../../../src/runtime/agent/EventBus'
import { MockModelClient } from '../../../../../src/test-support/builders/MockModelClient'
import { WorkflowOrchestrator } from '../../../../../src/runtime/workflow/orchestrator/WorkflowOrchestrator'
import { _resetWorktreeLocksForTests } from '../../../../../src/runtime/worktree'
import type { AgentEvent } from '../../../../../src/runtime/agent/types'
import type {
  WorkflowDefinition,
  WorkflowRunContext,
  WorkflowResult
} from '../../../../../src/runtime/workflow/definitions/types'
import type { WorkflowHostDeps } from '../../../../../src/runtime/workflow/orchestrator/types'

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

/** 最小假 definition：run 主体由测试注入 */
function fakeDefinition(
  run: (ctx: WorkflowRunContext) => Promise<WorkflowResult>,
  overrides: Partial<WorkflowDefinition> = {}
): WorkflowDefinition {
  return {
    name: 'fake',
    description: '测试用 workflow',
    matchHints: [],
    stages: ['first', 'second'],
    run,
    ...overrides
  }
}

interface Harness {
  events: AgentEvent[]
  host: WorkflowHostDeps
}

function makeHarness(workspaceRoot: string, sessionId = 'sess-1'): Harness {
  const events: AgentEvent[] = []
  const eventBus = new EventBus()
  eventBus.on((event) => events.push(event))
  return {
    events,
    host: {
      workspaceRoot,
      sessionId,
      eventBus,
      modelClient: new MockModelClient(),
      resolveTool: () => undefined
    }
  }
}

function makeOrchestrator(definition: WorkflowDefinition): WorkflowOrchestrator {
  return new WorkflowOrchestrator({
    resolveDefinition: (name) => (name === definition.name ? definition : undefined)
  })
}

describe('WorkflowOrchestrator', () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'nova-wf-orch-'))
    _resetWorktreeLocksForTests()
  })

  afterEach(() => {
    _resetWorktreeLocksForTests()
    rmSync(tmp, { recursive: true, force: true })
  })

  it('未知 workflow 与非法起始阶段直接 failed，不创建 run', async () => {
    const orch = makeOrchestrator(fakeDefinition(async () => ({ status: 'completed' })))
    const h = makeHarness(tmp)

    const unknown = await orch.start({
      workflow: 'nope',
      startStage: 'first',
      request: 'x',
      host: h.host
    })
    expect(unknown).toMatchObject({ status: 'failed' })

    const badStage = await orch.start({
      workflow: 'fake',
      startStage: 'nonexistent',
      request: 'x',
      host: h.host
    })
    expect(badStage).toMatchObject({ status: 'failed' })
    expect(orch.listActiveRuns()).toHaveLength(0)
  })

  it('成功路径：running → completed，进度事件与 run 状态都投影出去', async () => {
    const definition = fakeDefinition(async (ctx) => {
      ctx.host.progress('first', 'started')
      ctx.host.progress('first', 'completed')
      return { status: 'completed', summary: '干完了' }
    })
    const orch = makeOrchestrator(definition)
    const h = makeHarness(tmp)

    const outcome = await orch.start({
      workflow: 'fake',
      startStage: 'first',
      request: '做点事',
      host: h.host
    })

    expect(outcome).toMatchObject({ status: 'completed', summary: '干完了' })
    const progress = h.events.filter((e) => e.type === 'workflow_progress')
    expect(progress).toHaveLength(2)
    const runStates = h.events.filter(
      (e): e is Extract<AgentEvent, { type: 'workflow_run_state' }> =>
        e.type === 'workflow_run_state'
    )
    expect(runStates.map((e) => e.status)).toEqual(['running', 'completed'])
    expect(runStates[1].sessionId).toBe('sess-1')

    const snap = orch.getStatus(outcome.runId)
    expect(snap).toMatchObject({ status: 'completed', workflow: 'fake' })
    // 阶段名由 host.progress 推进，快照读的是同一份状态
    expect(snap?.phase).toBe('first')
    expect(orch.listActiveRuns()).toHaveLength(0)
  })

  it('definition 返回 failed 与抛异常都收敛为 failed 终态', async () => {
    const failing = makeOrchestrator(
      fakeDefinition(async () => ({ status: 'failed', reason: 'plan 失败' }))
    )
    const failed = await failing.start({
      workflow: 'fake',
      startStage: 'first',
      request: 'x',
      host: makeHarness(tmp).host
    })
    expect(failed).toMatchObject({ status: 'failed', error: 'plan 失败' })

    const throwing = makeOrchestrator(
      fakeDefinition(async () => {
        throw new Error('内部炸了')
      })
    )
    const thrown = await throwing.start({
      workflow: 'fake',
      startStage: 'first',
      request: 'x',
      host: makeHarness(tmp).host
    })
    expect(thrown).toMatchObject({ status: 'failed', error: '内部炸了' })
  })

  it('cancel 穿透到 TaskScope：definition 的 abortSignal 被 abort，run 终态为 cancelled', async () => {
    let seenSignal: AbortSignal | null = null
    let released = false
    const definition = fakeDefinition(async (ctx) => {
      seenSignal = ctx.abortSignal
      await new Promise<void>((resolve) => {
        ctx.abortSignal.addEventListener('abort', () => resolve(), { once: true })
      })
      released = true
      return { status: 'completed' }
    })
    const orch = makeOrchestrator(definition)
    const h = makeHarness(tmp)

    const pending = orch.start({
      workflow: 'fake',
      startStage: 'first',
      request: 'x',
      host: h.host,
      graceMs: 50
    })
    // 让 definition 先跑起来并注册 abort 监听
    await Promise.resolve()
    await Promise.resolve()

    const active = orch.getActiveRunForSession('sess-1')
    expect(active).toMatchObject({ status: 'running' })
    expect(await orch.cancel(active!.runId)).toBe(true)

    const outcome = await pending
    expect(outcome).toEqual({ status: 'cancelled', runId: active!.runId })
    expect(seenSignal?.aborted).toBe(true)
    expect(released).toBe(true)
    // 已终态：重复 cancel 返回 false
    expect(await orch.cancel(active!.runId)).toBe(false)
    expect(orch.getActiveRunForSession('sess-1')).toBeNull()
    // 终态广播必须发出，否则 renderer 的输入框无法退出运行态
    const runStates = h.events.filter(
      (e): e is Extract<AgentEvent, { type: 'workflow_run_state' }> =>
        e.type === 'workflow_run_state'
    )
    expect(runStates.map((e) => e.status)).toEqual(['running', 'cancelled'])
  })

  it('外部 abortSignal 触发等价于 cancel', async () => {
    const controller = new AbortController()
    const definition = fakeDefinition(
      (ctx) =>
        new Promise((resolve) => {
          ctx.abortSignal.addEventListener(
            'abort',
            () => resolve({ status: 'completed' }),
            { once: true }
          )
        })
    )
    const orch = makeOrchestrator(definition)

    const pending = orch.start({
      workflow: 'fake',
      startStage: 'first',
      request: 'x',
      host: makeHarness(tmp).host,
      abortSignal: controller.signal,
      graceMs: 50
    })
    await Promise.resolve()
    controller.abort()

    expect(await pending).toMatchObject({ status: 'cancelled' })
  })

  it('cancelForSession 只取消该会话的运行中 run', async () => {
    const definition = fakeDefinition(
      (ctx) =>
        new Promise((resolve) => {
          ctx.abortSignal.addEventListener(
            'abort',
            () => resolve({ status: 'completed' }),
            { once: true }
          )
        })
    )
    const orch = makeOrchestrator(definition)
    const a = makeHarness(tmp, 'sess-a')
    const b = makeHarness(tmp, 'sess-b')

    const runA = orch.start({
      workflow: 'fake',
      startStage: 'first',
      request: 'x',
      host: a.host,
      graceMs: 50
    })
    const runB = orch.start({
      workflow: 'fake',
      startStage: 'first',
      request: 'y',
      host: b.host,
      graceMs: 50
    })
    await Promise.resolve()

    const cancelled = await orch.cancelForSession('sess-a')
    expect(cancelled).toHaveLength(1)
    expect(await runA).toMatchObject({ status: 'cancelled' })
    expect(orch.getActiveRunForSession('sess-b')).toMatchObject({ status: 'running' })

    await orch.cancelForSession('sess-b')
    expect(await runB).toMatchObject({ status: 'cancelled' })
  })

  it('worktree 生命周期：成功且有改动保留，pristine 删除', async () => {
    initRepo(tmp)
    let dirtyDir = ''
    let pristineDir = ''
    const definition = fakeDefinition(async (ctx) => {
      const dirty = await ctx.host.worktree('task-dirty')
      const pristine = await ctx.host.worktree('task-pristine')
      dirtyDir = dirty.directory
      pristineDir = pristine.directory
      writeFileSync(join(dirty.directory, 'changed.txt'), 'hello', 'utf-8')
      return { status: 'completed' }
    })

    await makeOrchestrator(definition).start({
      workflow: 'fake',
      startStage: 'first',
      request: 'x',
      host: makeHarness(tmp).host
    })

    expect(existsSync(dirtyDir)).toBe(true)
    expect(existsSync(pristineDir)).toBe(false)
  })

  it('worktree 生命周期：失败时删除全部 worktree', async () => {
    initRepo(tmp)
    let dirtyDir = ''
    const definition = fakeDefinition(async (ctx) => {
      const wt = await ctx.host.worktree('task-1')
      dirtyDir = wt.directory
      writeFileSync(join(wt.directory, 'changed.txt'), 'hello', 'utf-8')
      return { status: 'failed', reason: '实现失败' }
    })

    const outcome = await makeOrchestrator(definition).start({
      workflow: 'fake',
      startStage: 'first',
      request: 'x',
      host: makeHarness(tmp).host
    })

    expect(outcome.status).toBe('failed')
    expect(existsSync(dirtyDir)).toBe(false)
  })

  it('worktree 生命周期：取消时删除全部 worktree', async () => {
    initRepo(tmp)
    let dir = ''
    const definition = fakeDefinition(async (ctx) => {
      const wt = await ctx.host.worktree('task-1')
      dir = wt.directory
      writeFileSync(join(wt.directory, 'changed.txt'), 'x', 'utf-8')
      await new Promise<void>((resolve) => {
        ctx.abortSignal.addEventListener('abort', () => resolve(), { once: true })
      })
      return { status: 'completed' }
    })
    const orch = makeOrchestrator(definition)

    const pending = orch.start({
      workflow: 'fake',
      startStage: 'first',
      request: 'x',
      host: makeHarness(tmp).host,
      graceMs: 50
    })
    // 等 worktree 建好再取消
    while (dir === '') await new Promise((r) => setTimeout(r, 10))

    await orch.cancelForSession('sess-1')
    expect(await pending).toMatchObject({ status: 'cancelled' })
    expect(existsSync(dir)).toBe(false)
  })

  it('grace 内未收敛（仍有子任务运行）时跳过 worktree 回收', async () => {
    initRepo(tmp)
    let dir = ''
    let lingerResolve = (): void => {}
    const linger = new Promise<void>((resolve) => {
      lingerResolve = resolve
    })
    const definition = fakeDefinition(async (ctx) => {
      const wt = await ctx.host.worktree('task-1')
      dir = wt.directory
      // 不响应 abort 的任务：definition 自身就是 scope 追踪的任务，
      // 它在 grace 内不退出即等价于「仍有子任务占用目录」
      await linger
      return { status: 'completed' }
    })
    const orch = makeOrchestrator(definition)

    const pending = orch.start({
      workflow: 'fake',
      startStage: 'first',
      request: 'x',
      host: makeHarness(tmp).host,
      graceMs: 10
    })
    while (dir === '') await new Promise((r) => setTimeout(r, 10))

    const cancelling = orch.cancelForSession('sess-1')
    await cancelling
    // grace 结束时 definition 仍未退出 → 目录必须保留
    expect(existsSync(dir)).toBe(true)
    lingerResolve()
    await pending
  })
})
