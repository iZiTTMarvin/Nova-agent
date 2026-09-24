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
  return `web_search — search the web. Use it when you need up-to-date information (version numbers, best practices, API docs, framework features) that local tools cannot answer.

**Works without an API key**: results are scraped via Bing / DuckDuckGo by default. If a Tavily API key is configured in settings, it joins the fallback chain as a quality enhancement.

**Parameters**
- query (string, required): search keywords or question. Include an explicit time word or version number, e.g. "React ${year} new features".
- maxResults (number, optional): maximum number of results to return; defaults to 5, upper bound limited by the provider.
- recency (string, optional): time-range filter, one of day | week | month | year, to keep only results from that window (Tavily only).

**Result format**
Returns a summary (answer — usually absent for scraped results) and a list of URL sources. **For most questions snippet + answer suffice; use web_fetch to read the full page only when truly needed** (re-reading the same URL within 2 days hits the cache at zero cost).

**Example**
When the user asks "What is the latest version of React?", search "React ${year} latest version" and answer from the returned sources' summaries.`
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
        description: 'Search keywords or question. Include an explicit time word, e.g. "React 2026 new features".'
      },
      maxResults: {
        type: 'number',
        description: 'Maximum number of results to return. Defaults to 5.',
        minimum: 1,
        maximum: 20
      },
      recency: {
        type: 'string',
        description: 'Time-range filter: day | week | month | year.',
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
          output: formatForLLM(response)
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
