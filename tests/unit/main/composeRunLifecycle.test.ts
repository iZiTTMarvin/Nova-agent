/**
 * Compose ↔ RunCoordinator 生命周期桥接单测
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  createRunCoordinator,
  RunExecutionRegistry
} from '../../../src/runtime/run'
import { runComposeWithLifecycle } from '../../../src/main/ipc/composeRunLifecycle'
import type { RunOutcome, RunWorkflowOptions } from '../../../src/runtime/workflow/types'

describe('runComposeWithLifecycle', () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'nova-compose-life-'))
  })

  afterEach(() => {
    try {
      rmSync(tmp, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('统一 runId：coordinator 与 workflow 共用同一 id，终态 completed', async () => {
    const coord = createRunCoordinator(tmp)
    const registry = new RunExecutionRegistry({ graceMs: 50 })
    let seenOpts: RunWorkflowOptions | null = null

    const result = await runComposeWithLifecycle(
      {
        coord,
        registry,
        cancelWorkflow: () => true,
        runWorkflow: async (opts) => {
          seenOpts = opts
          expect(opts.runId).toBeTruthy()
          expect(opts.assertExecutionCurrent?.()).toBe(true)
          return {
            status: 'completed',
            runId: opts.runId!,
            result: 'ok'
          } satisfies RunOutcome
        }
      },
      {
        workspaceRoot: tmp,
        sessionId: 'sess-1',
        workflowOpts: {
          script: 'br-full-dev',
          deps: {
            modelClient: {} as never,
            parentEventBus: { emit: () => {}, on: () => () => {} } as never,
            resolveTool: () => undefined,
            workspaceRoot: tmp
          }
        }
      }
    )

    expect(result.status).toBe('completed')
    expect(seenOpts?.runId).toBe(result.runId)
    const snap = coord.getSnapshot(result.runId)
    expect(snap?.status).toBe('completed')
    expect(snap?.kind).toBe('compose')
    expect(registry.hasUnsettledHandle('compose')).toBe(false)
  })

  it('generation 失效后 assertExecutionCurrent 为 false', async () => {
    const coord = createRunCoordinator(tmp)
    const registry = new RunExecutionRegistry({ graceMs: 50 })
    let assertFn: (() => boolean) | undefined

    await runComposeWithLifecycle(
      {
        coord,
        registry,
        cancelWorkflow: () => true,
        runWorkflow: async (opts) => {
          assertFn = opts.assertExecutionCurrent
          expect(assertFn?.()).toBe(true)
          coord.invalidateExecutionGeneration(opts.runId!)
          expect(assertFn?.()).toBe(false)
          return { status: 'failed', runId: opts.runId!, error: 'fenced' }
        }
      },
      {
        workspaceRoot: tmp,
        sessionId: 'sess-2',
        workflowOpts: {
          script: 'br-full-dev',
          deps: {
            modelClient: {} as never,
            parentEventBus: { emit: () => {}, on: () => () => {} } as never,
            resolveTool: () => undefined,
            workspaceRoot: tmp
          }
        }
      }
    )

    expect(assertFn).toBeDefined()
  })

  it('未 settled 的 compose 句柄存在时拒绝新开', async () => {
    const coord = createRunCoordinator(tmp)
    const registry = new RunExecutionRegistry({ graceMs: 5_000 })
    let resolveHang!: () => void
    const hang = new Promise<void>((r) => {
      resolveHang = r
    })

    // 先占一个未 settled 句柄
    const snap = coord.startRun({
      kind: 'compose',
      workspaceId: tmp,
      sessionId: 's'
    })
    registry.register({
      runId: snap.runId,
      generation: 1,
      kind: 'compose',
      abort: () => {},
      settled: hang
    })

    await expect(
      runComposeWithLifecycle(
        {
          coord,
          registry,
          cancelWorkflow: () => true,
          runWorkflow: async () => ({ status: 'completed', runId: 'x' })
        },
        {
          workspaceRoot: tmp,
          workflowOpts: {
            script: 'br-full-dev',
            deps: {
              modelClient: {} as never,
              parentEventBus: { emit: () => {}, on: () => () => {} } as never,
              resolveTool: () => undefined,
              workspaceRoot: tmp
            }
          }
        }
      )
    ).rejects.toThrow(/尚未完全退出/)

    resolveHang()
    await hang
  })

  it('composeHandler 源码经 lifecycle 接入 coordinator', async () => {
    const { readFileSync } = await import('fs')
    const { join: pathJoin } = await import('path')
    const src = readFileSync(
      pathJoin(__dirname, '../../../src/main/ipc/composeHandler.ts'),
      'utf-8'
    )
    expect(src).toMatch(/runComposeWithLifecycle/)
    expect(src).toMatch(/getRunExecutionRegistry/)
    expect(src).toMatch(/beginCancel/)
    expect(src).not.toMatch(/await runWorkflow\(\{/)
  })
})
