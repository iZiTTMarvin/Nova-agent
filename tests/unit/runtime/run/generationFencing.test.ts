/**
 * P0-2：lingering handle / generation fencing 契约
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  createRunCoordinator,
  RunExecutionRegistry,
  waitForSettlement
} from '../../../../src/runtime/run'

describe('generation fencing 与 lingering handle', () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'nova-gen-fence-'))
  })

  afterEach(() => {
    try {
      rmSync(tmp, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('grace 超时后不得 unregister lingering handle；settled 后按 generation 自动清理', async () => {
    const registry = new RunExecutionRegistry({ graceMs: 30 })
    let resolveSettled!: () => void
    const settled = new Promise<void>(r => {
      resolveSettled = r
    })

    registry.register({
      runId: 'run_linger',
      generation: 7,
      kind: 'agent',
      abort: () => {
        /* 故意不立刻 settle */
      },
      settled
    })

    const result = await registry.abort('run_linger', 'force', 30)
    expect(result.settled).toBe(false)
    expect(result.lingering).toBe(true)
    // lingering 仍在 registry
    expect(registry.get('run_linger')?.generation).toBe(7)
    expect(registry.isCurrent('run_linger', 7)).toBe(false) // 已 invalidate

    // 无 generation 的盲删必须拒绝
    expect(registry.unregister('run_linger')).toBe(false)
    expect(registry.get('run_linger')).not.toBeNull()

    resolveSettled()
    await settled
    // 给 microtask 一点时间跑 settled.then 自动注销
    await new Promise(r => setTimeout(r, 10))
    expect(registry.get('run_linger')).toBeNull()
  })

  it('abort 抛异常仍返回结果，供调用方提交 interrupted', async () => {
    const registry = new RunExecutionRegistry({ graceMs: 50 })
    let resolveSettled!: () => void
    const settled = new Promise<void>(r => {
      resolveSettled = r
    })
    registry.register({
      runId: 'run_abort_err',
      generation: 1,
      kind: 'agent',
      abort: () => {
        throw new Error('abort boom')
      },
      settled
    })

    const result = await registry.abort('run_abort_err', 'force')
    expect(result.abortError).toMatch(/abort boom/)
    expect(result.generation).toBe(1)
    resolveSettled()
  })

  it('权威 snapshot.executionGeneration：失效后 isExecutionCurrent 为 false', () => {
    const coord = createRunCoordinator(tmp)
    const snap = coord.startRun({
      kind: 'agent',
      workspaceId: 'ws',
      sessionId: 's1',
      runId: 'run_fence1'
    })
    coord.markRunning(snap.runId)
    coord.bindExecutionGeneration(snap.runId, 42)
    expect(coord.isExecutionCurrent(snap.runId, 42)).toBe(true)
    expect(coord.getSnapshot(snap.runId)?.executionGeneration).toBe(42)

    coord.invalidateExecutionGeneration(snap.runId)
    expect(coord.isExecutionCurrent(snap.runId, 42)).toBe(false)
    expect(coord.getSnapshot(snap.runId)?.executionGeneration).toBe(0)
  })

  it('waitForSettlement 超时后清理 timer，settled 仍可完成', async () => {
    let resolveSettled!: () => void
    const settled = new Promise<void>(r => {
      resolveSettled = r
    })
    const ok = await waitForSettlement(settled, 20)
    expect(ok).toBe(false)
    resolveSettled()
    await settled
  })

  it('hasUnsettledHandle 在 lingering 期间为 true，阻止新共享 AgentLoop', async () => {
    const registry = new RunExecutionRegistry({ graceMs: 20 })
    let resolveSettled!: () => void
    const settled = new Promise<void>(r => {
      resolveSettled = r
    })
    registry.register({
      runId: 'run_block',
      generation: 1,
      kind: 'agent',
      abort: () => undefined,
      settled
    })
    await registry.abort('run_block', 'x', 20)
    expect(registry.hasUnsettledHandle('agent')).toBe(true)
    resolveSettled()
    await settled
    await new Promise(r => setTimeout(r, 10))
    expect(registry.hasUnsettledHandle('agent')).toBe(false)
  })

  it('runHandler 源码：grace 路径不得无条件 unregister', async () => {
    const { readFileSync } = await import('fs')
    const src = readFileSync(
      join(__dirname, '../../../../src/main/ipc/runHandler.ts'),
      'utf-8'
    )
    const start = src.indexOf('handle(RUN_FORCE_TERMINATE')
    const end = src.indexOf('handle(RUN_INTERRUPTED_ACTION')
    const block = src.slice(start, end)
    // 不得在 grace/lingering 分支无 generation 地 unregister
    expect(block).toMatch(/invalidateExecutionGeneration/)
    expect(block).toMatch(/lingering:\s*true/)
    // 禁止 grace 后盲删：unregister(params.runId) 无第二参
    expect(block).not.toMatch(/registry\.unregister\(params\.runId\)\s*$/m)
    expect(block).not.toMatch(/registry\.unregister\(params\.runId\)\s*\n/)
  })
})
