/**
 * 阶段 0 护栏：TaskScope abort 后若底层 fn 仍在跑，不得报告已收敛。
 *
 * 当前缺陷（专家 P0-6）：abort 时外层 Promise 立即 reject 并从 children 删除，
 * 底层 fn(signal) 可继续；close() 误判收敛。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  TaskScope,
  _resetTaskScopeIdForTests
} from '../../../../src/runtime/workflow/TaskScope'

describe('P0-6 TaskScope 真实收敛', () => {
  beforeEach(() => {
    _resetTaskScopeIdForTests()
  })

  it('abort 后内部 Promise 仍运行时，close 不得报告已全部收敛', async () => {
    const scope = new TaskScope({ label: 'linger', graceMs: 80 })
    let innerFinished = false

    // 忽略 signal：模拟不配合取消的底层任务
    void scope.spawn(async () => {
      await new Promise((r) => setTimeout(r, 300))
      innerFinished = true
      return 'done'
    })

    await scope.close('cancelled')

    // 契约：close 返回值或查询 API 必须暴露 lingering
    const closeResult = (
      scope as unknown as {
        lastCloseResult?: { settled: boolean; lingeringTaskIds: string[] }
      }
    ).lastCloseResult

    // 若 API 为 close(): Promise<CloseResult>
    expect(closeResult).toBeDefined()
    expect(closeResult!.settled).toBe(false)
    expect(closeResult!.lingeringTaskIds.length).toBeGreaterThan(0)

    // 宽限期内底层尚未结束
    expect(innerFinished).toBe(false)

    await new Promise((r) => setTimeout(r, 350))
    expect(innerFinished).toBe(true)
  })

  it(
    'spawn 必须同时追踪 actualPromise；visible reject 不得从收敛集合删除 actual',
    async () => {
      const scope = new TaskScope({ label: 'actual', graceMs: 50 })
      let actualDone = false

      const visible = scope.spawn(async () => {
        await new Promise((r) => setTimeout(r, 200))
        actualDone = true
      })

      // 立即 abort：visible 应拒绝
      const closePromise = scope.close('cancelled')
      await expect(visible).rejects.toThrow(/abort|cancel/i)
      await closePromise

      // actual 仍在跑时，children/actual 集合不得为空（通过 close 结果暴露）
      const result = (
        scope as unknown as {
          lastCloseResult?: { settled: boolean }
        }
      ).lastCloseResult
      expect(result?.settled).toBe(false)
      expect(actualDone).toBe(false)
    }
  )
})
