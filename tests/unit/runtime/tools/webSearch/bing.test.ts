/**
 * Bing provider 单元测试（mock fetch）
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bingProvider } from '../../../../../src/runtime/tools/webSearch/providers/bing'

const mockFetch = vi.fn<typeof fetch>()
const fixturePath = join(__dirname, '../../../../fixtures/webSearch/bing.html')

beforeEach(() => {
  mockFetch.mockReset()
  vi.stubGlobal('fetch', mockFetch)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('bingProvider', () => {
  it('isAvailable 恒为 true', () => {
    expect(bingProvider.isAvailable()).toBe(true)
  })

  it('search 成功时返回 SearchResponse（无 answer）', async () => {
    const html = readFileSync(fixturePath, 'utf-8')
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve(html)
    } as Response)

    const result = await bingProvider.search(
      { query: 'react', maxResults: 2 },
      new AbortController().signal
    )

    expect(result.provider).toBe('bing')
    expect(result.answer).toBeUndefined()
    expect(result.sources.length).toBeGreaterThan(0)

    const calledUrl = mockFetch.mock.calls[0][0] as string
    expect(calledUrl).toContain('bing.com/search')
    expect(calledUrl).toContain('q=react')
  })

  it('HTTP 错误时抛出 SearchProviderError', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      statusText: 'Forbidden'
    } as Response)

    await expect(
      bingProvider.search({ query: 'test' }, new AbortController().signal)
    ).rejects.toMatchObject({ provider: 'bing' })
  })

  it('解析结果为空时抛出错误', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve('<html><body>empty</body></html>')
    } as Response)

    await expect(
      bingProvider.search({ query: 'test' }, new AbortController().signal)
    ).rejects.toMatchObject({ provider: 'bing' })
  })
})
