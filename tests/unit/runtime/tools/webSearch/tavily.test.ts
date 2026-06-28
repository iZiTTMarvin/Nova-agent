/**
 * Tavily provider 单元测试
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tavilyProvider } from '../../../../../src/runtime/tools/webSearch/providers/tavily'

const mockFetch = vi.fn<typeof fetch>()

beforeEach(() => {
  mockFetch.mockReset()
  vi.stubGlobal('fetch', mockFetch)
  process.env.TAVILY_API_KEY = 'test-key'
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.TAVILY_API_KEY
})

describe('tavilyProvider', () => {
  it('isAvailable 在 API key 配置时返回 true', () => {
    expect(tavilyProvider.isAvailable()).toBe(true)
  })

  it('isAvailable 在 API key 缺失时返回 false', () => {
    delete process.env.TAVILY_API_KEY
    expect(tavilyProvider.isAvailable()).toBe(false)
  })

  it('search 成功时返回 SearchResponse', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          query: 'React latest version',
          answer: 'React 19 is the latest.',
          results: [
            {
              title: 'React 19',
              url: 'https://react.dev',
              content: 'React 19 release notes',
              published_date: '2026-01-01'
            }
          ]
        })
    } as Response)

    const result = await tavilyProvider.search(
      { query: 'React latest version', maxResults: 5 },
      new AbortController().signal
    )

    expect(result.provider).toBe('tavily')
    expect(result.answer).toBe('React 19 is the latest.')
    expect(result.sources).toHaveLength(1)
    expect(result.sources[0].url).toBe('https://react.dev')
    expect(result.sources[0].snippet).toBe('React 19 release notes')
  })

  it('search HTTP 错误时抛出 SearchProviderError', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: 'Unauthorized'
    } as Response)

    await expect(
      tavilyProvider.search({ query: 'test' }, new AbortController().signal)
    ).rejects.toMatchObject({ provider: 'tavily', statusCode: 401 })
  })

  it('recency 参数映射到 time_range', async () => {
    let capturedBody: Record<string, unknown> = {}
    mockFetch.mockImplementation(async (_url, init) => {
      capturedBody = JSON.parse(init!.body as string)
      return { ok: true, json: () => Promise.resolve({ query: '', results: [] }) } as Response
    })

    await tavilyProvider.search({ query: 'test', recency: 'month' }, new AbortController().signal)

    expect(capturedBody.time_range).toBe('month')
  })
})
