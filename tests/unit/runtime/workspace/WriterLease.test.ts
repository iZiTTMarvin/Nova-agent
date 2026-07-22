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
})
