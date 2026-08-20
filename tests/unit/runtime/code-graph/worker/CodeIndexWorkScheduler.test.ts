import { describe, expect, it } from 'vitest'
import {
  CodeIndexBuildCancelledError,
  CodeIndexWorkScheduler
} from '@runtime/code-graph/worker/CodeIndexWorkScheduler'

describe('CodeIndexWorkScheduler', () => {
  it('多核时留出一核，单核时保持最小可用并发', async () => {
    expect(new CodeIndexWorkScheduler({ cpuCount: 1 }).concurrency).toBe(1)
    expect(new CodeIndexWorkScheduler({ cpuCount: 2 }).concurrency).toBe(1)
    expect(new CodeIndexWorkScheduler({ cpuCount: 4 }).concurrency).toBe(3)
    expect(new CodeIndexWorkScheduler({ cpuCount: 32 }).concurrency).toBe(4)

    const scheduler = new CodeIndexWorkScheduler({ cpuCount: 5 })
    let active = 0
    let peak = 0
    const releases: Array<() => void> = []
    const run = scheduler.map(
      Array.from({ length: 8 }, (_, index) => index),
      async (index) => {
        active += 1
        peak = Math.max(peak, active)
        await new Promise<void>((resolve) => releases.push(resolve))
        active -= 1
        return index * 2
      }
    )
    await expect.poll(() => releases.length).toBe(4)
    while (releases.length > 0) releases.shift()?.()
    await expect.poll(() => releases.length).toBe(4)
    while (releases.length > 0) releases.shift()?.()

    await expect(run).resolves.toEqual([0, 2, 4, 6, 8, 10, 12, 14])
    expect(peak).toBe(4)
  })

  it('在批次让出点观察取消，不再启动后续任务', async () => {
    const controller = new AbortController()
    const started: number[] = []
    const scheduler = new CodeIndexWorkScheduler({ cpuCount: 2 })
    const run = scheduler.map([1, 2, 3], async (value) => {
      started.push(value)
      controller.abort()
      return value
    }, { abortSignal: controller.signal })

    await expect(run).rejects.toBeInstanceOf(CodeIndexBuildCancelledError)
    expect(started).toEqual([1])
  })
})
