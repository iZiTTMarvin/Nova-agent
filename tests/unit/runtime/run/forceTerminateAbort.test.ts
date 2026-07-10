/**
 * 阶段 0 护栏：强制终止必须真正 abort 执行句柄，不能只写 cancelled 快照。
 *
 * 当前缺陷（专家 P0-2）：runHandler.force-terminate 只 commitTerminal，
 * 不 abort AgentLoop / TaskScope；Renderer 随后直接复位 UI。
 * 本测试在 RunExecutionRegistry 落地前以契约形式固定期望；阶段 1 实现后转绿。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createRunCoordinator } from '../../../../src/runtime/run'

describe('P0-2 force-terminate 必须 abort 执行句柄', () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'nova-force-term-'))
  })

  afterEach(() => {
    try {
      rmSync(tmp, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it(
    '契约：存在 RunExecutionRegistry，force terminate 会 abort 并等待 settled',
    async () => {
      const mod = await import('../../../../src/runtime/run/RunExecutionRegistry').catch(
        () => null
      )
      expect(mod).not.toBeNull()
      expect(mod).toHaveProperty('RunExecutionRegistry')

      const { RunExecutionRegistry } = mod as {
        RunExecutionRegistry: new () => {
          register: (h: {
            runId: string
            generation: number
            kind: 'agent' | 'compose'
            abort: (reason: string) => void
            settled: Promise<void>
          }) => void
          abort: (runId: string, reason: string) => Promise<{ settled: boolean }>
          get: (runId: string) => { generation: number } | null
        }
      }

      const registry = new RunExecutionRegistry()
      const coord = createRunCoordinator(tmp)
      const snap = coord.startRun({
        kind: 'agent',
        workspaceId: '/ws',
        sessionId: 's1'
      })
      coord.markRunning(snap.runId)

      let aborted = false
      let resolveSettled!: () => void
      const settled = new Promise<void>((r) => {
        resolveSettled = r
      })

      registry.register({
        runId: snap.runId,
        generation: 1,
        kind: 'agent',
        abort: () => {
          aborted = true
          setTimeout(resolveSettled, 20)
        },
        settled
      })

      const result = await registry.abort(snap.runId, 'force_terminate')
      expect(aborted).toBe(true)
      expect(result.settled).toBe(true)
    }
  )

  it(
    '契约：runHandler 强制终止必须 abort 执行句柄，不能只写 cancelled 快照',
    async () => {
      const { readFileSync } = await import('fs')
      const src = readFileSync(
        join(__dirname, '../../../../src/main/ipc/runHandler.ts'),
        'utf-8'
      )
      // handle(RUN_FORCE_TERMINATE, ...) 整段直到下一个 handle(
      const start = src.indexOf('handle(RUN_FORCE_TERMINATE')
      const end = src.indexOf('handle(RUN_INTERRUPTED_ACTION')
      expect(start).toBeGreaterThanOrEqual(0)
      expect(end).toBeGreaterThan(start)
      const forceBlock = src.slice(start, end)
      expect(forceBlock).toMatch(/RunExecutionRegistry|getRunExecutionRegistry|abort\(/)
      const hasDirectCancelOnly =
        /commitTerminal\(\s*\{[^}]*status:\s*'cancelled'/.test(forceBlock) &&
        !/abort/.test(forceBlock)
      expect(hasDirectCancelOnly).toBe(false)
    }
  )
})
