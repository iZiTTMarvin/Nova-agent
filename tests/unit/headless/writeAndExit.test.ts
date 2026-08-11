/**
 * writeAndExit 的退出保证：数据刷完后退出；管道对端异常时兜底定时器接管。
 * 锁的是「评测 harness 等进程退出」这条生命线——残留句柄不能再卡住进程。
 */
import { describe, it, expect, vi } from 'vitest'
import { PassThrough } from 'node:stream'
import { writeAndExit } from '../../../src/headless/writeAndExit'

describe('writeAndExit', () => {
  it('数据被消费后立即按给定退出码退出', async () => {
    const stream = new PassThrough()
    const exit = vi.fn()
    const chunks: Buffer[] = []
    stream.on('data', chunk => chunks.push(chunk))

    writeAndExit(stream, 'summary-line\n', 3, exit)

    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(3))
    expect(Buffer.concat(chunks).toString()).toBe('summary-line\n')
  })

  it('管道始终无人消费时由兜底定时器强制退出', async () => {
    vi.useFakeTimers()
    try {
      // highWaterMark=1 且无人读：write 回调不会触发，模拟对端卡死
      const stream = new PassThrough({ highWaterMark: 1 })
      const exit = vi.fn()

      writeAndExit(stream, 'x'.repeat(64), 7, exit)
      expect(exit).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(5_000)
      expect(exit).toHaveBeenCalledWith(7)
    } finally {
      vi.useRealTimers()
    }
  })

  it('回调与兜底同时到达时只退出一次', async () => {
    vi.useFakeTimers()
    try {
      const stream = new PassThrough()
      stream.resume()
      const exit = vi.fn()

      writeAndExit(stream, 'ok\n', 0, exit)
      await vi.advanceTimersByTimeAsync(10_000)

      expect(exit).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
