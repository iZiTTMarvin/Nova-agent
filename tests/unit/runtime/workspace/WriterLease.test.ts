/**
 * 写者租约单测：acquire / release / 排队 / 超时 / 幂等。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  writerLeaseRegistry,
  DEFAULT_LEASE_TIMEOUT_MS
} from '../../../../src/runtime/workspace/WriterLease'

describe('WorkspaceWriterLeaseRegistry', () => {
  beforeEach(() => {
    writerLeaseRegistry.resetForTests()
  })
  afterEach(() => {
    writerLeaseRegistry.resetForTests()
  })

  it('无持租者时立即获取租约', async () => {
    const r = await writerLeaseRegistry.acquire('/ws', 'runA')
    expect(r.ok).toBe(true)
    expect(writerLeaseRegistry.holder('/ws')).toBe('runA')
  })

  it('同一 run 重复 acquire 幂等', async () => {
    await writerLeaseRegistry.acquire('/ws', 'runA')
    const r = await writerLeaseRegistry.acquire('/ws', 'runA')
    expect(r.ok).toBe(true)
    expect(writerLeaseRegistry.holder('/ws')).toBe('runA')
  })

  it('不同工作区互不阻塞', async () => {
    await writerLeaseRegistry.acquire('/ws1', 'runA')
    const r = await writerLeaseRegistry.acquire('/ws2', 'runB')
    expect(r.ok).toBe(true)
    expect(writerLeaseRegistry.holder('/ws1')).toBe('runA')
    expect(writerLeaseRegistry.holder('/ws2')).toBe('runB')
  })

  it('其他 run 的 acquire 等待，release 后按 FIFO 唤醒', async () => {
    await writerLeaseRegistry.acquire('/ws', 'runA')
    const bp = writerLeaseRegistry.acquire('/ws', 'runB')
    const cp = writerLeaseRegistry.acquire('/ws', 'runC')

    // 此时仍由 runA 持租
    expect(writerLeaseRegistry.holder('/ws')).toBe('runA')

    writerLeaseRegistry.release('runA')
    const b = await bp
    expect(b.ok).toBe(true)
    expect(writerLeaseRegistry.holder('/ws')).toBe('runB')

    writerLeaseRegistry.release('runB')
    const c = await cp
    expect(c.ok).toBe(true)
    expect(writerLeaseRegistry.holder('/ws')).toBe('runC')
  })

  it('超时未拿到租约返回冲突结果', async () => {
    await writerLeaseRegistry.acquire('/ws', 'runA', DEFAULT_LEASE_TIMEOUT_MS)
    const r = await writerLeaseRegistry.acquire('/ws', 'runB', 50)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toBe('timeout')
      expect(r.holderRunId).toBe('runA')
    }
  })

  it('release 一个不持租的 run 不影响其它', async () => {
    await writerLeaseRegistry.acquire('/ws', 'runA')
    writerLeaseRegistry.release('runX') // 不持任何租约
    expect(writerLeaseRegistry.holder('/ws')).toBe('runA')
  })

  it('release 后队列中的等待者若已超时仍能正确流转', async () => {
    await writerLeaseRegistry.acquire('/ws', 'runA')
    // runB 短超时，会先超时
    const bp = writerLeaseRegistry.acquire('/ws', 'runB', 30)
    // runC 长超时
    const cp = writerLeaseRegistry.acquire('/ws', 'runC', 5000)
    // 等 runB 超时
    const b = await bp
    expect(b.ok).toBe(false)
    // 释放 runA，runC 应拿到
    writerLeaseRegistry.release('runA')
    const c = await cp
    expect(c.ok).toBe(true)
    expect(writerLeaseRegistry.holder('/ws')).toBe('runC')
  })

  it('release 清理该 run 在等待队列里的残留 waiter，避免授予已死 run 造成永久死锁', async () => {
    // 场景：A 持租 → B 排队等待 → 取消 B（release B）→ A 释放 →
    // 租约不应授予已死的 B，而应由后续真正排队的 C 拿到（或无人时回到空闲）。
    await writerLeaseRegistry.acquire('/ws', 'runA')
    const bp = writerLeaseRegistry.acquire('/ws', 'runB', 60_000)
    // B 还在排队时被取消
    writerLeaseRegistry.release('runB')
    const b = await bp
    expect(b.ok).toBe(false)
    if (!b.ok) expect(b.reason).toBe('aborted')

    // A 释放后，因 B 已被清出队列，租约应回到空闲（不授予已死的 B）
    writerLeaseRegistry.release('runA')
    expect(writerLeaseRegistry.holder('/ws')).toBeNull()

    // 后续新 run 可立即获取，不存在死锁
    const r = await writerLeaseRegistry.acquire('/ws', 'runC')
    expect(r.ok).toBe(true)
    expect(writerLeaseRegistry.holder('/ws')).toBe('runC')
  })

  it('abortSignal 触发时排队中的 acquire 立即返回 aborted 并出队', async () => {
    await writerLeaseRegistry.acquire('/ws', 'runA')
    const ac = new AbortController()
    const bp = writerLeaseRegistry.acquire('/ws', 'runB', 60_000, ac.signal)
    // 触发取消
    ac.abort()
    const b = await bp
    expect(b.ok).toBe(false)
    if (!b.ok) expect(b.reason).toBe('aborted')

    // B 已出队：A 释放后租约回到空闲，不授予已取消的 B
    writerLeaseRegistry.release('runA')
    expect(writerLeaseRegistry.holder('/ws')).toBeNull()
  })
})
