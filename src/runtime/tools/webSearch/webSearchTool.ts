/**
 * web_search 联网搜索工具
 * 通过 Bing → DuckDuckGo → Tavily fallback 链查询互联网
 */
import type { ToolExecutor, ToolContext, ToolResult } from '../types'
import type { SearchProviderError, SearchResponse } from './types'
import { getAvailableProviders } from './providers'
import { formatForLLM } from './formatters'

const TOOL_NAME = 'web_search'

/**
 * 工具描述（给模型看的 prompt）。
 * 年份在 buildDescription 时通过模板字符串注入当前年份。
 */
function buildDescription(year: number): string {
  return `web_search — 联网搜索工具。当需要查找最新信息（如版本号、最佳实践、API 文档、框架特性）且本地工具无法回答时使用。

**无需 API Key 也可用**：默认通过 Bing / DuckDuckGo 爬虫获取搜索结果。若在设置中配置了 Tavily API Key，将作为质量增强参与 fallback 链。

**参数**
- query (string, 必需): 搜索关键词或问句。建议包含明确时间词或版本号，例如 "React ${year} new features"。
- maxResults (number, 可选): 最大返回结果数，默认 5，上限受 provider 限制。
- recency (string, 可选): 时间范围过滤，取值 day | week | month | year，表示只返回指定时间内的结果（仅 Tavily 支持）。

**结果格式**
返回摘要（answer，爬虫结果通常无 answer）和 URL 来源列表（sources）。**注意：当前 read 工具只支持本地文件路径，不支持读取 HTTP URL**——v1 依赖 sources 中的 snippet 与 answer 作答。

**使用示例**
当用户问 "React 最新版本是多少" 时，搜索 "React ${year} latest version"，参考返回的 sources 摘要作答。`
}

const TOOL_DESCRIPTION = buildDescription(new Date().getFullYear())
const MAX_RESULT_SIZE_CHARS = 50_000

export const webSearchTool: ToolExecutor = {
  name: TOOL_NAME,
  description: TOOL_DESCRIPTION,
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: '搜索关键词或问句。建议包含明确时间词，例如 "React 2026 new features"。'
      },
      maxResults: {
        type: 'number',
        description: '最大返回结果数。默认 5。',
        minimum: 1,
        maximum: 20
      },
      recency: {
        type: 'string',
        description: '时间范围过滤：day | week | month | year。',
        enum: ['day', 'week', 'month', 'year']
      }
    },
    required: ['query'],
    additionalProperties: false
  },
  executionMode: 'sequential',
  maxResultSizeChars: MAX_RESULT_SIZE_CHARS,

  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const query = args.query as string
    const maxResults = (args.maxResults as number | undefined) ?? 5
    const recency = args.recency as 'day' | 'week' | 'month' | 'year' | undefined

    const providers = getAvailableProviders()
    // bing/ddg 正常情况下恒可用；仅当全部 provider 不可用时才报错
    if (providers.length === 0) {
      return {
        success: false,
        output: '',
        error: '没有可用的搜索 provider。请稍后重试，或在设置中配置 Tavily API Key 作为增强。'
      }
    }

    const errors: SearchProviderError[] = []
    const signal = context.abortSignal ?? new AbortController().signal

    for (const provider of providers) {
      try {
        const response: SearchResponse = await provider.search(
          { query, maxResults, recency },
          signal
        )
        return {
          success: true,
          output: formatForLLM(response)
        }
      } catch (err) {
        const providerError: SearchProviderError =
          err && typeof err === 'object' && 'provider' in err
            ? (err as SearchProviderError)
            : {
                provider: provider.name,
                message: err instanceof Error ? err.message : String(err)
              }
        errors.push(providerError)
      }
    }

    const errorSummary = errors.map(e => `${e.provider}: ${e.message}`).join('；')
    return {
      success: false,
      output: '',
      error: `搜索服务全部失败：${errorSummary}`
    }
  }
}
