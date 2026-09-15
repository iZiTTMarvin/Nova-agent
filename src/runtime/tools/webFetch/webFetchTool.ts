/**
 * web_fetch 联网读链接工具：与 web_search 配对（搜索找链接，fetch 读全文）。
 *
 * 四层成本闸门：安全闸门 → 缓存闸门 → 提取闸门 → 质量地板。
 * 大页不截断（不声明 maxResultSizeChars），交由既有大结果归档通道
 * 先完整投递一轮、滑出窗口后成批归档；仅设病态天花板（明确报错，不静默砍）。
 */
import type { ToolExecutor, ToolContext, ToolResult } from '../types'
import { scraperFetchResponse } from '../webSearch/scraper/http'
import { checkUrl } from './urlGate'
import { extractContent } from './extractor'
import { cacheGet, cachePut } from './fetchCache'

const TOOL_NAME = 'web_fetch'

/** 提取后正文超此字符数明确报错：当轮全文投递会撑爆请求，宁报错不砍头 */
const PATHOLOGICAL_MAX_CHARS = 200_000
/** 手动跟随重定向的上限（含环与长链保护） */
const MAX_REDIRECTS = 8

const TOOL_DESCRIPTION = `web_fetch — 读网页全文工具。打开一个 HTTP(S) 链接，提取正文转为 Markdown 返回。
当 web_search 的摘要不够、或用户直接给了链接时使用。

**参数**
- url (string, 必需): 要读取的完整 URL（http/https）。
- force (boolean, 可选): 跳过缓存强制重抓。默认 false——同一链接 2 天内重读直接返回缓存。

**行为**
- 正文提取剥掉导航/广告/侧栏，典型页面减重 60–80%；
- 需要 JS 渲染的页面会明确报错（建议改用浏览器工具），不返回垃圾内容；
- 页面过大时明确报错而不是静默截断；
- localhost 可直接读取（本地开发服务器）。

**与 web_search 配对**：先用 web_search 找到链接，确需全文时再用本工具读。`

interface FetchedPage {
  finalUrl: string
  body: string
  contentType?: string
  fromCache: boolean
  fetchedAt: number
}

/** 抓取 + 每跳安全校验：302 到内网/元数据在这里被拦下 */
async function fetchWithGate(url: string, signal?: AbortSignal): Promise<FetchedPage> {
  let current = url
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const verdict = await checkUrl(current, hop === 0 ? 'initial' : 'per-hop')
    if (!verdict.ok) {
      throw new GateError(verdict.detail)
    }
    const response = await scraperFetchResponse(verdict.normalizedUrl, { signal })
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      if (!location) {
        throw new GateError(`HTTP ${response.status} 重定向缺少 Location 头`)
      }
      current = new URL(location, verdict.normalizedUrl).toString()
      continue
    }
    if (!response.ok) {
      throw new GateError(`HTTP ${response.status}: ${response.statusText}`)
    }
    const contentType = response.headers.get('content-type') ?? undefined
    return {
      finalUrl: verdict.normalizedUrl,
      body: await response.text(),
      contentType,
      fromCache: false,
      fetchedAt: Date.now()
    }
  }
  throw new GateError(`重定向超过 ${MAX_REDIRECTS} 跳（疑似重定向环）`)
}

class GateError extends Error {}

function normalizeCacheKey(url: string): string {
  const parsed = new URL(url)
  parsed.hash = ''
  parsed.hostname = parsed.hostname.toLowerCase()
  if ((parsed.protocol === 'http:' && parsed.port === '80') || (parsed.protocol === 'https:' && parsed.port === '443')) {
    parsed.port = ''
  }
  return parsed.toString()
}

function formatOutput(page: FetchedPage, markdown: string, degraded: boolean): string {
  const cacheNote = page.fromCache
    ? `缓存，${Math.max(1, Math.round((Date.now() - page.fetchedAt) / 60000))} 分钟前抓取`
    : '新抓取'
  const warning = degraded ? '\n\n> 注意：此页正文过短，可能未提取到完整内容，原文降级返回。\n' : '\n'
  return `URL：${page.finalUrl}\n状态：${cacheNote}${warning}\n正文：\n${markdown}`
}

export const webFetchTool: ToolExecutor = {
  name: TOOL_NAME,
  description: TOOL_DESCRIPTION,
  parameters: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: '要读取的完整 URL，必须是 http 或 https。'
      },
      force: {
        type: 'boolean',
        description: '跳过缓存强制重新抓取。默认 false。'
      }
    },
    required: ['url'],
    additionalProperties: false
  },
  executionMode: 'sequential',
  // 有意不声明 maxResultSizeChars：执行器会在归档机制看到全文之前硬截断，
  // 大页走「先完整投递一轮、滑出窗口再归档」的既有通道。
  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const url = args.url as string
    const force = args.force === true
    const signal = context.abortSignal

    let cached: ReturnType<typeof cacheGet> = null
    try {
      cached = force ? null : cacheGet(normalizeCacheKey(url))
    } catch {
      cached = null
    }

    let page: FetchedPage
    if (cached) {
      page = {
        finalUrl: cached.finalUrl,
        body: cached.content,
        contentType: cached.contentType,
        fetchedAt: cached.fetchedAt,
        fromCache: true
      }
    } else {
      const gate = await checkUrl(url)
      if (!gate.ok) {
        return { success: false, output: '', error: gate.detail }
      }
      try {
        page = await fetchWithGate(url, signal)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return { success: false, output: '', error: `抓取失败：${message}` }
      }
    }

    const extraction = await extractContent(page.body, page.contentType)
    if (extraction.kind === 'js-shell') {
      return {
        success: false,
        output: '',
        error: `${extraction.detail}。此页需要浏览器渲染，建议告知用户改用浏览器工具查看。`
      }
    }

    const content =
      extraction.kind === 'markdown' ? extraction.markdown : extraction.text
    if (content.length > PATHOLOGICAL_MAX_CHARS) {
      return {
        success: false,
        output: '',
        error: `页面过大（提取后 ${content.length} 字符，上限 ${PATHOLOGICAL_MAX_CHARS}）。建议：告知用户该页面过大，改用 web_search 检索其中的具体信息，或让用户在浏览器中查看。`
      }
    }

    if (!page.fromCache && content.length > 0) {
      cachePut(normalizeCacheKey(url), {
        finalUrl: page.finalUrl,
        content: page.body,
        contentType: page.contentType,
        fetchedAt: page.fetchedAt
      })
    }

    const degraded = extraction.kind === 'short-with-warning'
    return {
      success: true,
      output: formatOutput(page, content, degraded)
    }
  }
}
