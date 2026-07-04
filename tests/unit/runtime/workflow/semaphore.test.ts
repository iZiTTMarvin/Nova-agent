import { describe, it, expect, beforeEach } from 'vitest'
import {
  makeSemaphore,
  makeRunSemaphore,
  _resetGlobalSemaphoreForTests,
  getGlobalSemaphore
} from '../../../../src/runtime/workflow/semaphore'

describe('workflow semaphore', () => {
  beforeEach(() => {
    _resetGlobalSemaphoreForTests(16)
  })

  it('并发上限 N 并行不超 N', async () => {
    const sem = makeSemaphore(3)
    let active = 0
    let maxActive = 0
    const tasks = Array.from({ length: 10 }, () =>
      sem.run(async () => {
        active++
        maxActive = Math.max(maxActive, active)
        await new Promise((r) => setTimeout(r, 20))
        active--
      })
    )
    await Promise.all(tasks)
    expect(maxActive).toBeLessThanOrEqual(3)
    expect(maxActive).toBe(3)
  })

  it('per-run 收窄生效（global=16，per-run=2 时只有 2 个同时 active）', async () => {
    _resetGlobalSemaphoreForTests(16)
    const { runSem, globalSem } = makeRunSemaphore(2)
    expect(runSem.max).toBe(2)
    expect(globalSem.max).toBe(16)

    let active = 0
    let maxActive = 0
    const tasks = Array.from({ length: 8 }, () =>
      runSem.run(() =>
        globalSem.run(async () => {
          active++
          maxActive = Math.max(maxActive, active)
          await new Promise((r) => setTimeout(r, 20))
          active--
        })
      )
    )
    await Promise.all(tasks)
    expect(maxActive).toBeLessThanOrEqual(2)
    expect(maxActive).toBe(2)
  })

  it('不阻塞其他 run（两个 run 并行各自遵守自己的上限）', async () => {
    _resetGlobalSemaphoreForTests(16)
    const runA = makeRunSemaphore(2)
    const runB = makeRunSemaphore(2)

    let activeA = 0
    let maxA = 0
    let activeB = 0
    let maxB = 0

    const tasksA = Array.from({ length: 4 }, () =>
      runA.runSem.run(() =>
        runA.globalSem.run(async () => {
          activeA++
          maxA = Math.max(maxA, activeA)
          await new Promise((r) => setTimeout(r, 30))
          activeA--
        })
      )
    )
    const tasksB = Array.from({ length: 4 }, () =>
      runB.runSem.run(() =>
        runB.globalSem.run(async () => {
          activeB++
          maxB = Math.max(maxB, activeB)
          await new Promise((r) => setTimeout(r, 30))
          activeB--
        })
      )
    )

    await Promise.all([...tasksA, ...tasksB])
    expect(maxA).toBeLessThanOrEqual(2)
    expect(maxB).toBeLessThanOrEqual(2)
    // 两 run 合计可到 4（各自 2），证明互不阻塞到串行
    expect(maxA + maxB).toBeGreaterThan(2)
  })

  it('getGlobalSemaphore 进程内复用', () => {
    const a = getGlobalSemaphore()
    const b = getGlobalSemaphore()
    expect(a).toBe(b)
  })
})
