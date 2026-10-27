/**
 * web_search 联网搜索工具
 * 优先免密钥 Exa，失败时沿现有 provider 链降级。
 */
import type { ToolExecutor, ToolContext, ToolResult } from '../types'
import type { SearchProviderError, SearchResponse } from './types'
import { getAvailableProviders } from './providers'
import { formatForLLM } from './formatters'

const TOOL_NAME = 'web_search'

const TOOL_DESCRIPTION = 'web_search — search the web for current information and return source-linked results. Prefer snippets; use web_fetch only when page content or exact fields are needed.'
const MAX_RESULT_SIZE_CHARS = 50_000
const CODE_MODE_RESULT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    provider: { type: 'string', enum: ['bing', 'duckduckgo', 'tavily', 'brave', 'exa', 'keenable'] },
    answer: { type: 'string' },
    sources: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          url: { type: 'string' },
          snippet: { type: 'string' },
          publishedDate: { type: 'string' }
        },
        required: ['title', 'url'],
        additionalProperties: false
      }
    },
    requestId: { type: 'string' }
  },
  required: ['provider', 'sources'],
  additionalProperties: false
}

export const webSearchTool: ToolExecutor = {
  name: TOOL_NAME,
  description: TOOL_DESCRIPTION,
  codeModeResultSchema: CODE_MODE_RESULT_SCHEMA,
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search keywords or question; add time or version terms when relevant.'
      },
      maxResults: {
        type: 'number',
        description: 'Maximum number of results to return. Defaults to 5.',
        minimum: 1,
        maximum: 20
      },
      recency: {
        type: 'string',
        description: 'Prefer sources published within: day | week | month | year.',
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
    // 匿名搜索无需凭据；配置的增强 provider 仍参与原有降级链。
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
      if (signal.aborted) {
        return { success: false, output: '', error: '搜索已取消：请求已取消' }
      }
      try {
        const response: SearchResponse = await provider.search(
          { query, maxResults, recency },
          signal
        )
        return {
          success: true,
          output: formatForLLM(response),
          structuredContent: {
            provider: response.provider,
            ...(response.answer !== undefined ? { answer: response.answer } : {}),
            sources: response.sources.map(source => ({
              title: source.title,
              url: source.url,
              ...(source.snippet !== undefined ? { snippet: source.snippet } : {}),
              ...(source.publishedDate !== undefined ? { publishedDate: source.publishedDate } : {})
            })),
            ...(response.requestId !== undefined ? { requestId: response.requestId } : {})
          }
        }
      } catch (err) {
        if (signal.aborted) {
          return { success: false, output: '', error: '搜索已取消：请求已取消' }
        }
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
