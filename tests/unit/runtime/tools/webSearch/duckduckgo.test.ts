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

  it('失败后进入冷却期', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable'
    } as Response)

    await expect(
      duckduckgoProvider.search({ query: 'fail' }, new AbortController().signal)
    ).rejects.toMatchObject({ provider: 'duckduckgo' })

    expect(duckduckgoProvider.isAvailable()).toBe(false)
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

  it('用户取消时不触发冷却', async () => {
    const controller = new AbortController()
    controller.abort()
    mockFetch.mockRejectedValueOnce(new DOMException('Aborted', 'AbortError'))

    await expect(
      duckduckgoProvider.search({ query: 'cancel' }, controller.signal)
    ).rejects.toMatchObject({ provider: 'duckduckgo', message: '请求已取消' })

    expect(duckduckgoProvider.isAvailable()).toBe(true)
  })
})
