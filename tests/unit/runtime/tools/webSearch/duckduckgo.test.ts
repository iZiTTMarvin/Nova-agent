/**
 * DuckDuckGo provider 单元测试（mock fetch + 冷却逻辑）
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  duckduckgoProvider,
  markDdgUnavailable,
  resetDdgCooldown
} from '../../../../../src/runtime/tools/webSearch/providers/duckduckgo'

const mockFetch = vi.fn<typeof fetch>()
const fixturePath = join(__dirname, '../../../../fixtures/webSearch/ddg.html')

beforeEach(() => {
  mockFetch.mockReset()
  vi.stubGlobal('fetch', mockFetch)
  resetDdgCooldown()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  resetDdgCooldown()
})

describe('duckduckgoProvider', () => {
  it('isAvailable 默认 true，冷却后 false', () => {
    expect(duckduckgoProvider.isAvailable()).toBe(true)
    markDdgUnavailable()
    expect(duckduckgoProvider.isAvailable()).toBe(false)
  })

  it('冷却 10 分钟后恢复可用', () => {
    markDdgUnavailable()
    expect(duckduckgoProvider.isAvailable()).toBe(false)
    vi.advanceTimersByTime(10 * 60 * 1000 + 1)
    expect(duckduckgoProvider.isAvailable()).toBe(true)
  })

  it('search 成功时返回 SearchResponse', async () => {
    const html = readFileSync(fixturePath, 'utf-8')
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve(html)
    } as Response)

    const result = await duckduckgoProvider.search(
      { query: 'react', maxResults: 2 },
      new AbortController().signal
    )

    expect(result.provider).toBe('duckduckgo')
    expect(result.sources).toHaveLength(2)

    const [url, init] = mockFetch.mock.calls[0]
    expect(url).toContain('html.duckduckgo.com')
    expect((init as RequestInit).method).toBe('POST')
  })

  it('失败后进入冷却期并释放未读取的响应正文', async () => {
    let bodyCancelled = false
    const body = new ReadableStream({
      cancel: () => {
        bodyCancelled = true
      }
    })
    mockFetch.mockResolvedValueOnce(new Response(body, {
      status: 503,
      statusText: 'Service Unavailable'
    }))

    await expect(
      duckduckgoProvider.search({ query: 'fail' }, new AbortController().signal)
    ).rejects.toMatchObject({ provider: 'duckduckgo' })

    expect(duckduckgoProvider.isAvailable()).toBe(false)
    expect(bodyCancelled).toBe(true)
  })

  it('零结果时不触发冷却（由工具层 fallback）', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve('<html><body>empty</body></html>')
    } as Response)

    await expect(
      duckduckgoProvider.search({ query: 'empty' }, new AbortController().signal)
    ).rejects.toMatchObject({ provider: 'duckduckgo', message: '未返回搜索结果' })

    expect(duckduckgoProvider.isAvailable()).toBe(true)
  })

  it('并发搜索按 2 秒启动间隔串行执行', async () => {
    const html = readFileSync(fixturePath, 'utf-8')
    let active = 0
    let maxActive = 0
    const starts: number[] = []
    mockFetch.mockImplementation(async () => {
      active++
      maxActive = Math.max(maxActive, active)
      starts.push(Date.now())
      return {
        ok: true,
        text: async () => {
          await new Promise(resolve => setTimeout(resolve, 100))
          active--
          return html
        }
      } as Response
    })

    const first = duckduckgoProvider.search({ query: 'first' }, new AbortController().signal)
    const second = duckduckgoProvider.search({ query: 'second' }, new AbortController().signal)
    await vi.advanceTimersByTimeAsync(0)
    expect(mockFetch).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(100)
    expect(mockFetch).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1_900)
    await vi.advanceTimersByTimeAsync(100)
    await Promise.all([first, second])

    expect(maxActive).toBe(1)
    expect(starts).toHaveLength(2)
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(2_000)
  })

  it('本地队列饱和不应触发 provider 全局冷却', async () => {
    const html = readFileSync(fixturePath, 'utf-8')
    mockFetch.mockImplementation(async () => new Response(html))
    const pending = Promise.allSettled(Array.from({ length: 5 }, (_, index) =>
      duckduckgoProvider.search({ query: `query-${index}` }, new AbortController().signal)
    ))
    await vi.advanceTimersByTimeAsync(8_001)
    const results = await pending
    expect(results.map(result => result.status)).toEqual([
      'fulfilled', 'fulfilled', 'fulfilled', 'fulfilled', 'rejected'
    ])
    expect(mockFetch).toHaveBeenCalledTimes(4)
    expect(duckduckgoProvider.isAvailable()).toBe(true)
  })

  it('排队等待期间取消不会发起第二次请求，也不触发冷却', async () => {
    const html = readFileSync(fixturePath, 'utf-8')
    mockFetch.mockResolvedValue({
      ok: true,
      text: async () => {
        await new Promise(resolve => setTimeout(resolve, 100))
        return html
      }
    } as Response)
    const first = duckduckgoProvider.search({ query: 'first' }, new AbortController().signal)
    const controller = new AbortController()
    const second = duckduckgoProvider.search({ query: 'second' }, controller.signal)
    const third = duckduckgoProvider.search({ query: 'third' }, new AbortController().signal)
    await vi.advanceTimersByTimeAsync(0)
    controller.abort()
    await expect(second).rejects.toMatchObject({ provider: 'duckduckgo', message: '请求已取消' })
    await vi.advanceTimersByTimeAsync(100)
    await first
    // 第二项取消后，第三项仍须等第一项规定间隔结束，不能穿透队列。
    expect(mockFetch).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1_900)
    await vi.advanceTimersByTimeAsync(100)
    await third
    expect(mockFetch).toHaveBeenCalledTimes(2)
    expect(duckduckgoProvider.isAvailable()).toBe(true)
  })

  it('排队超过总超时时按时失败且不发起后续请求', async () => {
    mockFetch.mockImplementationOnce((_url, init) => {
      let streamController: ReadableStreamDefaultController<Uint8Array> | undefined
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller
        }
      })
      init?.signal?.addEventListener('abort', () => {
        streamController?.error(new DOMException('Aborted', 'AbortError'))
      })
      return Promise.resolve(new Response(body, { status: 200 }))
    })
    const first = duckduckgoProvider.search({ query: 'slow-first' }, new AbortController().signal)
    const second = duckduckgoProvider.search({ query: 'queued-second' }, new AbortController().signal)
    const firstResult = expect(first).rejects.toMatchObject({ provider: 'duckduckgo', message: '请求超时（8000ms）' })
    const secondResult = expect(second).rejects.toMatchObject({ provider: 'duckduckgo', message: '请求超时（8000ms）' })
    await vi.advanceTimersByTimeAsync(8_000)
    await Promise.all([firstResult, secondResult])
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('正文消费期间用户取消时不触发冷却', async () => {
    const controller = new AbortController()
    mockFetch.mockImplementationOnce((_url, init) => {
      let streamController: ReadableStreamDefaultController<Uint8Array> | undefined
      const body = new ReadableStream<Uint8Array>({
        start(innerController) {
          streamController = innerController
          innerController.enqueue(new TextEncoder().encode('<html>'))
        }
      })
      init?.signal?.addEventListener('abort', () => {
        streamController?.error(new DOMException('Aborted', 'AbortError'))
      })
      return Promise.resolve(new Response(body, { status: 200 }))
    })

    const pending = duckduckgoProvider.search({ query: 'cancel' }, controller.signal)
    await Promise.resolve()
    controller.abort()

    await expect(pending).rejects.toMatchObject({ provider: 'duckduckgo', message: '请求已取消' })
    expect(duckduckgoProvider.isAvailable()).toBe(true)
  })
})
