/**
 * webSearchTool.execute 单元测试
 * 覆盖 provider fallback、错误提示、参数透传与 abortSignal
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SearchProvider, SearchQueryParams, SearchResponse } from '../../../../../src/shared/webSearch/types'
import { createReadState } from '../../../../../src/runtime/tools/editTool'
import type { ToolContext } from '../../../../../src/runtime/tools/types'

const mockGetAvailableProviders = vi.fn<() => SearchProvider[]>()

vi.mock('../../../../../src/runtime/tools/webSearch/providers', () => ({
  getAvailableProviders: () => mockGetAvailableProviders()
}))

import { webSearchTool } from '../../../../../src/runtime/tools/webSearch'

function createContext(overrides?: Partial<ToolContext>): ToolContext {
  return {
    workingDir: '/tmp',
    readState: createReadState(),
    ...overrides
  }
}

function mockProvider(
  name: SearchProvider['name'],
  impl: {
    isAvailable?: () => boolean
    search: SearchProvider['search']
  }
): SearchProvider {
  return {
    name,
    isAvailable: impl.isAvailable ?? (() => true),
    search: impl.search
  }
}

const bingSuccessResponse: SearchResponse = {
  provider: 'bing',
  sources: [{ title: '示例', url: 'https://example.com', snippet: '摘要' }]
}

const ddgSuccessResponse: SearchResponse = {
  provider: 'duckduckgo',
  sources: [{ title: 'DDG 结果', url: 'https://ddg.example.com', snippet: 'DDG 摘要' }]
}

const tavilySuccessResponse: SearchResponse = {
  provider: 'tavily',
  answer: '测试回答',
  sources: [{ title: '示例', url: 'https://example.com', snippet: '摘要' }]
}

describe('webSearchTool.execute', () => {
  beforeEach(() => {
    mockGetAvailableProviders.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('无可用 provider 时返回中文错误（不强调 Tavily 必填）', async () => {
    mockGetAvailableProviders.mockReturnValue([])

    const result = await webSearchTool.execute({ query: 'test' }, createContext())

    expect(result.success).toBe(false)
    expect(result.error).toContain('没有可用的搜索 provider')
    expect(result.error).not.toContain('请配置 Tavily API Key')
  })

  it('bing 成功时直接返回，不尝试后续 provider', async () => {
    const ddgSearch = vi.fn<SearchProvider['search']>()
    const tavilySearch = vi.fn<SearchProvider['search']>()

    mockGetAvailableProviders.mockReturnValue([
      mockProvider('bing', {
        search: vi.fn().mockResolvedValue(bingSuccessResponse)
      }),
      mockProvider('duckduckgo', { search: ddgSearch }),
      mockProvider('tavily', { search: tavilySearch })
    ])

    const result = await webSearchTool.execute({ query: 'bing ok' }, createContext())

    expect(result.success).toBe(true)
    expect(result.output).toContain('## Sources')
    expect(ddgSearch).not.toHaveBeenCalled()
    expect(tavilySearch).not.toHaveBeenCalled()
  })

  it('bing 失败时 fallback 到 duckduckgo', async () => {
    const ddgSearch = vi.fn<SearchProvider['search']>().mockResolvedValue(ddgSuccessResponse)

    mockGetAvailableProviders.mockReturnValue([
      mockProvider('bing', {
        search: vi.fn().mockRejectedValue({ provider: 'bing', message: '解析失败' })
      }),
      mockProvider('duckduckgo', { search: ddgSearch })
    ])

    const result = await webSearchTool.execute({ query: 'ddg fallback' }, createContext())

    expect(result.success).toBe(true)
    expect(result.output).toContain('DDG 结果')
    expect(ddgSearch).toHaveBeenCalledOnce()
  })

  it('bing 与 duckduckgo 均失败时 fallback 到 tavily', async () => {
    const tavilySearch = vi.fn<SearchProvider['search']>().mockResolvedValue(tavilySuccessResponse)

    mockGetAvailableProviders.mockReturnValue([
      mockProvider('bing', {
        search: vi.fn().mockRejectedValue({ provider: 'bing', message: '失败' })
      }),
      mockProvider('duckduckgo', {
        search: vi.fn().mockRejectedValue({ provider: 'duckduckgo', message: '失败' })
      }),
      mockProvider('tavily', { search: tavilySearch })
    ])

    const result = await webSearchTool.execute({ query: 'tavily fallback' }, createContext())

    expect(result.success).toBe(true)
    expect(result.output).toContain('测试回答')
    expect(tavilySearch).toHaveBeenCalledOnce()
  })

  it('全部 provider 失败时返回中文错误摘要', async () => {
    mockGetAvailableProviders.mockReturnValue([
      mockProvider('bing', {
        search: vi.fn().mockRejectedValue({ provider: 'bing', message: 'HTTP 403' })
      }),
      mockProvider('duckduckgo', {
        search: vi.fn().mockRejectedValue({ provider: 'duckduckgo', message: '解析失败' })
      }),
      mockProvider('tavily', {
        search: vi.fn().mockRejectedValue({ provider: 'tavily', message: 'HTTP 401: Unauthorized', statusCode: 401 })
      })
    ])

    const result = await webSearchTool.execute({ query: 'fail test' }, createContext())

    expect(result.success).toBe(false)
    expect(result.error).toBe(
      '搜索服务全部失败：bing: HTTP 403；duckduckgo: 解析失败；tavily: HTTP 401: Unauthorized'
    )
  })

  it('将 abortSignal 透传给 provider.search', async () => {
    const controller = new AbortController()
    const search = vi.fn<SearchProvider['search']>().mockResolvedValue(bingSuccessResponse)

    mockGetAvailableProviders.mockReturnValue([mockProvider('bing', { search })])

    await webSearchTool.execute({ query: 'abort test' }, createContext({ abortSignal: controller.signal }))

    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'abort test' }),
      controller.signal
    )
  })

  it('将 maxResults 与 recency 透传给 provider.search', async () => {
    let capturedParams: SearchQueryParams | undefined
    const search = vi.fn<SearchProvider['search']>().mockImplementation(async params => {
      capturedParams = params
      return bingSuccessResponse
    })

    mockGetAvailableProviders.mockReturnValue([mockProvider('bing', { search })])

    await webSearchTool.execute(
      { query: 'params test', maxResults: 10, recency: 'week' },
      createContext()
    )

    expect(capturedParams).toEqual({
      query: 'params test',
      maxResults: 10,
      recency: 'week'
    })
  })

  it('maxResults 缺省时默认为 5', async () => {
    let capturedParams: SearchQueryParams | undefined
    const search = vi.fn<SearchProvider['search']>().mockImplementation(async params => {
      capturedParams = params
      return bingSuccessResponse
    })

    mockGetAvailableProviders.mockReturnValue([mockProvider('bing', { search })])

    await webSearchTool.execute({ query: 'default max' }, createContext())

    expect(capturedParams?.maxResults).toBe(5)
  })
})
