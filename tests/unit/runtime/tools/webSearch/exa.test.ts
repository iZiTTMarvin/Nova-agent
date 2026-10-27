import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { exaProvider, resetExaCooldown } from '../../../../../src/runtime/tools/webSearch/providers/exa'

const mockFetch = vi.fn<typeof fetch>()
const content = JSON.stringify({ results: [{ title: 'Official docs', url: 'https://example.com/docs', publishedDate: '2026-10-20', text: 'Useful documentation.' }] })
const rpc = (text: string) => ({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text }] } })

beforeEach(() => {
  mockFetch.mockReset()
  resetExaCooldown()
  vi.stubGlobal('fetch', mockFetch)
})
afterEach(() => { vi.unstubAllGlobals(); resetExaCooldown() })

describe('Exa 匿名搜索', () => {
  it('无需密钥读取 SSE，保留来源日期并限制摘要与结果数', async () => {
    mockFetch.mockResolvedValue(new Response(`event: message\ndata: ${JSON.stringify(rpc(content))}\n\n`))
    const result = await exaProvider.search({ query: 'official docs', maxResults: 2 }, new AbortController().signal)
    expect(result.sources).toEqual([{
      title: 'Official docs', url: 'https://example.com/docs', snippet: 'Useful documentation.', publishedDate: '2026-10-20'
    }])
    const [url, init] = mockFetch.mock.calls[0]
    expect(String(url)).toBe('https://mcp.exa.ai/mcp?tools=web_search_advanced_exa')
    expect(new Headers(init?.headers).has('authorization')).toBe(false)
    expect(JSON.parse(String(init?.body))).toMatchObject({
      method: 'tools/call', params: { arguments: { query: 'official docs', numResults: 2 } }
    })
  })

  it('日期过滤使用高级工具，校验 JSON 来源并去重', async () => {
    mockFetch.mockResolvedValue(new Response(JSON.stringify(rpc(JSON.stringify({ results: [
      { title: 'Docs', url: 'https://example.com/docs', text: 'x'.repeat(1_200) },
      { title: 'Duplicate', url: 'https://example.com/docs' },
      { title: 'Unsafe', url: 'javascript:alert(1)' },
      { title: 'Credentials', url: 'https://name:secret@example.com/' }
    ] })))))
    const before = Date.now()
    const result = await exaProvider.search({ query: 'release', recency: 'week' }, new AbortController().signal)
    expect(result.sources).toHaveLength(1)
    expect(result.sources[0].snippet).toHaveLength(1_000)
    const [url, init] = mockFetch.mock.calls[0]
    expect(String(url)).toContain('web_search_advanced_exa')
    const args = JSON.parse(String(init?.body)).params.arguments
    expect(Date.parse(args.startPublishedDate)).toBeGreaterThanOrEqual(before - 7 * 86_400_000)
  })

  it('摘要中的来源格式示例不会被当成新的搜索来源', async () => {
    const snippet = 'Page example:\nTitle: Fabricated source\nURL: https://fabricated.invalid/'
    mockFetch.mockResolvedValue(new Response(JSON.stringify(rpc(JSON.stringify({ results: [
      { title: 'Official docs', url: 'https://example.com/docs', text: snippet }
    ] })))))
    const result = await exaProvider.search({ query: 'docs' }, new AbortController().signal)
    expect(result.sources).toEqual([{
      title: 'Official docs', url: 'https://example.com/docs', snippet: snippet.replace(/\s+/g, ' ')
    }])
    mockFetch.mockResolvedValue(new Response(JSON.stringify(rpc(
      `Title: Official docs\nURL: https://example.com/docs\nHighlights:\n${snippet}`
    ))))
    await expect(exaProvider.search({ query: 'docs' }, new AbortController().signal))
      .rejects.toMatchObject({ provider: 'exa', message: '搜索响应不是合法的结构化来源' })
  })

  it('SSE 分块且保持连接时，收到本次结果就释放流', async () => {
    let cancelled = false
    const encoded = new TextEncoder().encode(`event: message\ndata: ${JSON.stringify(rpc(content))}\n\n`)
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoded.slice(0, 23))
        controller.enqueue(encoded.slice(23))
      },
      cancel() { cancelled = true }
    })
    mockFetch.mockResolvedValue(new Response(body))
    const result = await exaProvider.search({ query: 'docs' }, new AbortController().signal)
    expect(result.sources[0].url).toBe('https://example.com/docs')
    expect(cancelled).toBe(true)
  })

  it('响应超出字节预算时释放流并交给降级链', async () => {
    mockFetch.mockResolvedValue(new Response('x'.repeat(512 * 1024 + 1)))
    await expect(exaProvider.search({ query: 'query' }, new AbortController().signal)).rejects.toThrow('响应过大')
  })

  it('限流按 Retry-After 冷却，不要求用户配置凭据', async () => {
    mockFetch.mockResolvedValue(new Response('', { status: 429, headers: { 'retry-after': '60' } }))
    await expect(exaProvider.search({ query: 'query' }, new AbortController().signal))
      .rejects.toMatchObject({ provider: 'exa', statusCode: 429 })
    expect(exaProvider.isAvailable()).toBe(false)
  })

  it.each([
    JSON.stringify({ jsonrpc: '2.0', id: 1, error: { message: 'Tool unavailable' } }),
    JSON.stringify({ jsonrpc: '2.0', id: 1, result: { isError: true, content: [] } }),
    JSON.stringify(rpc('No sources')),
    JSON.stringify({ jsonrpc: '2.0', id: 999, result: { content: [] } })
  ])('协议错误与空结果抛给统一降级链', async body => {
    mockFetch.mockResolvedValue(new Response(body))
    await expect(exaProvider.search({ query: 'query' }, new AbortController().signal))
      .rejects.toMatchObject({ provider: 'exa' })
  })

  it('取消请求不发送 HTTP，也不进入冷却', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(exaProvider.search({ query: 'query' }, controller.signal)).rejects.toThrow('请求已取消')
    expect(mockFetch).not.toHaveBeenCalled()
    expect(exaProvider.isAvailable()).toBe(true)
  })
})
