/**
 * TaskScope 结构化并发单测
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { TaskScope, withTaskScope, _resetTaskScopeIdForTests } from '../../../../src/runtime/workflow/TaskScope'
import { evalScript } from '../../../../src/runtime/workflow/sandbox'

describe('TaskScope', () => {
  beforeEach(() => {
    _resetTaskScopeIdForTests()
  })

  it('close 后 generation 递增，isCurrent 失败', async () => {
    const scope = new TaskScope({ label: 'g' })
    const gen = scope.captureGeneration()
    expect(scope.isCurrent(gen)).toBe(true)
    await scope.close('cancelled')
    expect(scope.isClosed).toBe(true)
    expect(scope.isCurrent(gen)).toBe(false)
    expect(scope.generation).toBe(gen + 1)
  })

  it('deadline 真正 abort，spawn 中的任务被取消', async () => {
    let continuedAfterAbort = false
    await expect(
      withTaskScope({ deadlineMs: 50, graceMs: 200 }, async (scope) => {
        await scope.spawn(async (signal) => {
          await new Promise<void>((resolve) => setTimeout(resolve, 200))
          if (!signal.aborted) continuedAfterAbort = true
        })
        // 等 deadline
        await new Promise((r) => setTimeout(r, 300))
        return 'ok'
      })
    ).rejects.toThrow(/deadline/)
    expect(continuedAfterAbort).toBe(false)
  })

  it('parallel 分支失败时兄弟任务被 abort（fail-fast，不空等慢分支）', async () => {
    const writes: string[] = []
    const scope = new TaskScope({ label: 'par-root', graceMs: 500 })
    const gen = scope.captureGeneration()
    const hooks = {
      write: (id: unknown) => {
        // 模拟 host：提交前检查 generation / closed
        if (!scope.isCurrent(gen) || scope.isClosed) return
        writes.push(String(id))
      },
      fail: async () => {
        await new Promise((r) => setTimeout(r, 20))
        throw new Error('branch-fail')
      },
      slow: async () => {
        await new Promise((r) => setTimeout(r, 400))
        return 'slow'
      }
    }

    const t0 = Date.now()
    await expect(
      evalScript(
        `
        await parallel([
          () => fail(),
          async () => { await slow(); write('after-slow'); }
        ]);
        return 1;
        `,
        hooks,
        { scope, deadlineMs: 5_000 }
      )
    ).rejects.toThrow(/branch-fail|rejected|aborted/)
    const elapsed = Date.now() - t0

    // 必须 fail-fast：不能干等 400ms 慢分支跑完才返回
    expect(elapsed).toBeLessThan(300)

    await scope.close('failed')
    // 根 scope 关闭后旧 continuation 的 write 被 generation 挡住
    await new Promise((r) => setTimeout(r, 500))
    expect(writes.includes('after-slow')).toBe(false)
  })

  it('close 后 spawn 抛错', async () => {
    const scope = new TaskScope()
    await scope.close('completed')
    expect(() => scope.spawn(async () => 1)).toThrow(/closed/)
  })

  it('重复 close 复用同一关闭过程，并报告真实任务已收敛', async () => {
    const scope = new TaskScope({ graceMs: 100 })
    void scope.spawn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })

    const first = scope.close('cancelled')
    const second = scope.close('failed')

    expect(second).toBe(first)
    await expect(first).resolves.toEqual({ settled: true, lingeringTaskIds: [] })
    expect(scope.reason).toBe('cancelled')
  })
})
