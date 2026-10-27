import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { keenableProvider } from '../../../../../src/runtime/tools/webSearch/providers/keenable'

const mockFetch = vi.fn<typeof fetch>()
beforeEach(() => { mockFetch.mockReset(); vi.stubGlobal('fetch', mockFetch) })
afterEach(() => vi.unstubAllGlobals())

describe('Keenable 匿名降级搜索', () => {
  it('使用公开端点和日期过滤，不发送凭据，规范化去重来源', async () => {
    mockFetch.mockResolvedValue(new Response(JSON.stringify({ results: [
      { url: 'https://example.com/docs', title: 'Docs', snippet: 'First\nsecond' },
      { url: 'https://example.com/docs', title: 'Duplicate' },
      { url: 'javascript:alert(1)', title: 'Unsafe' },
      { url: 'https://name:password@example.com', title: 'Credentials' }
    ] })))
    const response = await keenableProvider.search({ query: 'docs', recency: 'day', maxResults: 2 }, new AbortController().signal)
    expect(response).toMatchObject({ provider: 'keenable', sources: [{ title: 'Docs', url: 'https://example.com/docs', snippet: 'First second' }] })
    const [url, init] = mockFetch.mock.calls[0]
    expect(url).toBe('https://api.keenable.ai/v1/search/public')
    expect(new Headers(init?.headers).has('x-api-key')).toBe(false)
    expect(JSON.parse(String(init?.body))).toMatchObject({ query: 'docs', max_results: 2, published_after: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) })
  })

  it.each([{}, { results: [] }, { results: [{ url: 'not a URL' }] }])('无效结果交给后续来源降级', async value => {
    mockFetch.mockResolvedValue(new Response(JSON.stringify(value)))
    await expect(keenableProvider.search({ query: 'docs' }, new AbortController().signal)).rejects.toMatchObject({ provider: 'keenable' })
  })

  it('保留限流状态码，取消请求不产生外部调用', async () => {
    mockFetch.mockResolvedValue(new Response('', { status: 429 }))
    await expect(keenableProvider.search({ query: 'docs' }, new AbortController().signal))
      .rejects.toMatchObject({ provider: 'keenable', statusCode: 429 })
    const controller = new AbortController()
    controller.abort()
    await expect(keenableProvider.search({ query: 'docs' }, controller.signal)).rejects.toMatchObject({ message: '请求已取消' })
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })
})
