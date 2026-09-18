import { describe, expect, it } from 'vitest'
import { SubagentScheduler } from '../../../../src/runtime/subagents'

describe('SubagentScheduler', () => {
  it('分别执行 global 与 per-root 上限，并返回结构化拒绝', async () => {
    const scheduler = new SubagentScheduler({
      globalLimit: 2,
      perRootLimit: 1,
      maxQueued: 2,
      waitTimeoutMs: 100
    })
    const first = await scheduler.acquire({ runId: 'run-a-1', capacityKey: 'root-a', requestKey: 'a-1' })
    expect(first.ok).toBe(true)
    await expect(scheduler.acquire({ runId: 'run-a-2', capacityKey: 'root-a', requestKey: 'a-2' }))
      .resolves.toEqual(expect.objectContaining({ ok: false, code: 'root_limit' }))

    const second = await scheduler.acquire({ runId: 'run-b-1', capacityKey: 'root-b', requestKey: 'b-1' })
    expect(second.ok).toBe(true)
    await expect(scheduler.acquire({ runId: 'run-c-1', capacityKey: 'root-c', requestKey: 'c-1' }))
      .resolves.toEqual(expect.objectContaining({ ok: false, code: 'global_limit' }))

    if (first.ok) first.permit.release()
    if (second.ok) second.permit.release()
    expect(scheduler.snapshot()).toEqual(expect.objectContaining({ activeGlobal: 0, queued: 0 }))
  })

  it('稳定 capacityKey 让不同出生 root 共用同一棵父会话树的上限', async () => {
    const scheduler = new SubagentScheduler({
      globalLimit: 4,
      perRootLimit: 2
    })
    const first = await scheduler.acquire({
      runId: 'run-root-a-child',
      capacityKey: 'session-parent',
      requestKey: 'first'
    })
    const second = await scheduler.acquire({
      runId: 'run-root-b-child',
      capacityKey: 'session-parent',
      requestKey: 'second'
    })
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)

    await expect(scheduler.acquire({
      runId: 'run-root-a-third',
      capacityKey: 'session-parent',
      requestKey: 'third'
    })).resolves.toEqual(expect.objectContaining({ ok: false, code: 'root_limit' }))

    const otherTree = await scheduler.acquire({
      runId: 'run-other-tree',
      capacityKey: 'session-other',
      requestKey: 'other'
    })
    expect(otherTree.ok).toBe(true)

    if (first.ok) first.permit.release()
    if (second.ok) second.permit.release()
    if (otherTree.ok) otherTree.permit.release()
  })

  it('显式等待严格按 FIFO 发放且 permit 重复 release 安全', async () => {
    const scheduler = new SubagentScheduler({
      globalLimit: 1,
      perRootLimit: 1,
      maxQueued: 4,
      waitTimeoutMs: 1_000
    })
    const first = await scheduler.acquire({ runId: 'run-first', capacityKey: 'root', requestKey: 'first' })
    if (!first.ok) throw new Error('expected first permit')
    const order: string[] = []
    const secondPromise = scheduler.acquire({ runId: 'run-second', capacityKey: 'root', requestKey: 'second', wait: true })
      .then((result) => {
        if (!result.ok) throw new Error(result.message)
        order.push(result.permit.requestKey)
        return result.permit
      })
    const thirdPromise = scheduler.acquire({ runId: 'run-third', capacityKey: 'root', requestKey: 'third', wait: true })
      .then((result) => {
        if (!result.ok) throw new Error(result.message)
        order.push(result.permit.requestKey)
        return result.permit
      })

    first.permit.release()
    first.permit.release()
    const second = await secondPromise
    expect(order).toEqual(['second'])
    second.release()
    const third = await thirdPromise
    expect(order).toEqual(['second', 'third'])
    third.release()
  })

  it('等待请求可取消且不会遗留队列项', async () => {
    const scheduler = new SubagentScheduler({
      globalLimit: 1,
      perRootLimit: 1,
      maxQueued: 1,
      waitTimeoutMs: 1_000
    })
    const active = await scheduler.acquire({ runId: 'run-active', capacityKey: 'root', requestKey: 'active' })
    const controller = new AbortController()
    const pending = scheduler.acquire({
      runId: 'run-pending',
      capacityKey: 'root',
      requestKey: 'pending',
      wait: true,
      abortSignal: controller.signal
    })
    controller.abort()
    await expect(pending).resolves.toEqual(expect.objectContaining({ ok: false, code: 'aborted' }))
    expect(scheduler.snapshot().queued).toBe(0)
    if (active.ok) active.permit.release()
  })

  it('可按 runId 强制回收 permit，随后 finally 重复 release 不会破坏计数', async () => {
    const scheduler = new SubagentScheduler({ globalLimit: 1, perRootLimit: 1 })
    const result = await scheduler.acquire({
      runId: 'run-child',
      capacityKey: 'run-root',
      requestKey: 'child'
    })
    if (!result.ok) throw new Error('expected permit')

    expect(scheduler.releaseForRun('run-child')).toBe(true)
    result.permit.release()

    expect(scheduler.snapshot().activeGlobal).toBe(0)
    expect(scheduler.releaseForRun('run-child')).toBe(false)
  })

  it('同一 child run 不能跨服务实例重复持有或排队', async () => {
    const scheduler = new SubagentScheduler({ globalLimit: 2, perRootLimit: 2 })
    const first = await scheduler.acquire({
      runId: 'run-child',
      capacityKey: 'run-root',
      requestKey: 'first'
    })
    if (!first.ok) throw new Error('expected permit')

    await expect(scheduler.acquire({
      runId: 'run-child',
      capacityKey: 'run-root',
      requestKey: 'duplicate'
    })).resolves.toEqual(expect.objectContaining({ ok: false, code: 'run_active' }))

    first.permit.release()
  })
})
