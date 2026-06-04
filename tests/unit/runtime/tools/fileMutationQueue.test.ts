import { describe, it, expect } from 'vitest'
import { withFileMutationQueue } from '../../../../src/runtime/tools/editTool'

describe('fileMutationQueue', () => {
  it('同文件操作串行执行', async () => {
    const order: number[] = []
    const path = '/same/file'

    const p1 = withFileMutationQueue(path, async () => {
      await new Promise(r => setTimeout(r, 50))
      order.push(1)
    })

    const p2 = withFileMutationQueue(path, async () => {
      order.push(2)
    })

    await Promise.all([p1, p2])
    expect(order).toEqual([1, 2])
  })

  it('不同文件操作并行执行', async () => {
    const order: number[] = []

    const p1 = withFileMutationQueue('/file/a', async () => {
      await new Promise(r => setTimeout(r, 50))
      order.push(1)
    })

    const p2 = withFileMutationQueue('/file/b', async () => {
      order.push(2)
    })

    await Promise.all([p1, p2])
    expect(order).toEqual([2, 1])
  })

  it('前一个失败后下一个仍能执行', async () => {
    const path = '/fail/file'

    await expect(
      withFileMutationQueue(path, async () => {
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')

    const result = await withFileMutationQueue(path, async () => {
      return 'ok'
    })
    expect(result).toBe('ok')
  })
})
