/**
 * scraper/http.ts 单元测试
 * 直接覆盖 UA、Accept-Encoding、超时、取消等核心行为
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { scraperFetch } from '../../../../../../src/runtime/tools/webSearch/scraper/http'

const mockFetch = vi.fn<typeof fetch>()

beforeEach(() => {
  mockFetch.mockReset()
  vi.stubGlobal('fetch', mockFetch)
  vi.useFakeTimers()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('scraperFetch', () => {
  it('正常 GET 返回 HTML 文本', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve('<html>ok</html>')
    } as Response)

    const html = await scraperFetch('https://example.com/search')
    expect(html).toBe('<html>ok</html>')
  })

  it('请求头包含浏览器 UA 与 Accept-Encoding: identity', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve('')
    } as Response)

    await scraperFetch('https://example.com/search')

    const [, init] = mockFetch.mock.calls[0]
    const headers = (init as RequestInit).headers as Record<string, string>
    expect(headers['User-Agent']).toContain('Chrome')
    expect(headers['Accept-Encoding']).toBe('identity')
  })

  it('超时后抛出超时错误', async () => {
    mockFetch.mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'))
          })
        })
    )

    const promise = scraperFetch('https://example.com/slow', { timeoutMs: 1000 })
    const assertion = expect(promise).rejects.toThrow('请求超时（1000ms）')
    await vi.advanceTimersByTimeAsync(1001)
    await assertion
  })

  it('外部 abort 时抛出取消错误', async () => {
    const controller = new AbortController()
    mockFetch.mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'))
          })
        })
    )

    const promise = scraperFetch('https://example.com/search', { signal: controller.signal })
    controller.abort()
    await expect(promise).rejects.toThrow('请求已取消')
  })

  it('调用前 signal 已中止时立即抛出取消错误', async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(
      scraperFetch('https://example.com/search', { signal: controller.signal })
    ).rejects.toThrow('请求已取消')

    expect(mockFetch).not.toHaveBeenCalled()
  })
})
