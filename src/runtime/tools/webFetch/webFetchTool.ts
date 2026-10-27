/**
 * web_fetch：默认读取正文；显式 extract 时只返回字段、证据与不确定项。
 * 两种模式共用 URL 安全、重定向、原始页面缓存和正文提取，readable 行为保持不变。
 */
import { createHash } from 'crypto'
import type { ToolExecutor, ToolContext, ToolResult } from '../types'
import { withScraperResponse } from '../webSearch/scraper/http'
import { checkUrl } from './urlGate'
import { extractContent } from './extractor'
import { cacheGet, withCacheWrite, type CachedFetch } from './fetchCache'
import { WEB_FETCH_CODE_MODE_RESULT_SCHEMA } from './codeMode'
import {
  ExtractionResultCache,
  canonicalFieldSpecs,
  currentExtractionReferenceDate,
  extractPageFields,
  formatPageExtraction,
  parseExtractFields,
  resolveFieldExtractionProvider,
  type FieldExtractionProvider,
  type FieldSpec,
  type PageExtraction
} from './extraction'

const TOOL_NAME = 'web_fetch'
const PATHOLOGICAL_MAX_CHARS = 200_000
const MAX_REDIRECTS = 8
const TOOL_DESCRIPTION = 'web_fetch — fetch a page as Markdown, or use extract with fields for specific typed values. Extract sends page text to the selected extraction model; JS-only pages require browser tools.'

interface FetchedPage {
  finalUrl: string
  body: string
  contentType?: string
  fromCache: boolean
  fetchedAt: number
}

/** 抓取 + 每跳安全校验：302 到内网/元数据在这里被拦下。 */
async function fetchWithGate(url: string, signal?: AbortSignal): Promise<FetchedPage> {
  let current = url
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const verdict = await checkUrl(current, hop === 0 ? 'initial' : 'per-hop')
    if (!verdict.ok) throw new GateError(verdict.detail)
    const outcome = await withScraperResponse(
      verdict.normalizedUrl,
      { signal },
      async response => {
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location')
          if (!location) throw new GateError(`HTTP ${response.status} 重定向缺少 Location 头`)
          return { kind: 'redirect' as const, location }
        }
        if (!response.ok) throw new GateError(`HTTP ${response.status}: ${response.statusText}`)
        return {
          kind: 'page' as const,
          body: await response.text(),
          contentType: response.headers.get('content-type') ?? undefined
        }
      }
    )
    if (outcome.kind === 'redirect') {
      current = new URL(outcome.location, verdict.normalizedUrl).toString()
      continue
    }
    return {
      finalUrl: verdict.normalizedUrl,
      body: outcome.body,
      contentType: outcome.contentType,
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

function cacheNote(page: FetchedPage): string {
  return page.fromCache
    ? `页面缓存，${Math.max(1, Math.round((Date.now() - page.fetchedAt) / 60000))} 分钟前抓取`
    : '新抓取'
}

function formatReadableOutput(page: FetchedPage, markdown: string, degraded: boolean): string {
  const warning = degraded ? '\n\n> 注意：此页正文过短，可能未提取到完整内容，原文降级返回。\n' : '\n'
  return `URL：${page.finalUrl}\n状态：${cacheNote(page)}${warning}\n正文：\n${markdown}`
}

function formatExtractionOutput(page: FetchedPage, extraction: PageExtraction): string {
  const provider = extraction.provider === 'clairic' ? 'Clairic' : '当前模型'
  return `URL：${page.finalUrl}\n状态：${cacheNote(page)}；提取器：${provider}\n\n${formatPageExtraction(extraction)}`
}

function failure(error: string): ToolResult {
  return { success: false, output: '', error }
}

export function createWebFetchTool(): ToolExecutor {
  // 每个工具实例拥有自己的有界提取缓存；默认 readable 的磁盘缓存格式不变。
  const extractionCache = new ExtractionResultCache()

  return {
    name: TOOL_NAME,
    description: TOOL_DESCRIPTION,
    codeModeResultSchema: WEB_FETCH_CODE_MODE_RESULT_SCHEMA,
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The full http(s) URL to read.'
        },
        mode: {
          type: 'string',
          enum: ['readable', 'extract'],
          description: 'readable returns page content (default); extract returns only requested fields.'
        },
        fields: {
          type: 'object',
          description: 'Required for extract: field name to "type" or "type: what to find". Types: text, number, integer, date, time, datetime, duration[.<unit>], list, list.number, list.date.',
          additionalProperties: { type: 'string', maxLength: 600 },
          minProperties: 1,
          maxProperties: 16
        },
        force: {
          type: 'boolean',
          description: 'Bypass page and extraction caches. Defaults to false.'
        }
      },
      required: ['url'],
      additionalProperties: false
    },
    executionMode: 'parallel',
    isConcurrencySafe: () => true,
    // 保持 readable 的既有行为：大页先完整进入当轮上下文，后续由归档机制处理。
    async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
      const url = args.url as string
      const mode = args.mode ?? 'readable'
      const force = args.force === true
      const signal = context.abortSignal

      if (mode !== 'readable' && mode !== 'extract') return failure('mode 仅支持 readable 或 extract')
      if (mode === 'readable' && args.fields !== undefined) return failure('fields 只能与 mode=extract 一起使用')

      let fields: Record<string, FieldSpec> | undefined
      let provider: FieldExtractionProvider | undefined
      if (mode === 'extract') {
        try {
          fields = parseExtractFields(args.fields)
          provider = resolveFieldExtractionProvider({
            modelClient: context.modelClient,
            contextWindow: context.contextWindow,
            runId: context.runId,
            sessionId: context.sessionId
          })
        } catch (error) {
          return failure(error instanceof Error ? error.message : String(error))
        }
      }

      let cached: ReturnType<typeof cacheGet> = null
      let normalizedUrl = url
      try {
        normalizedUrl = normalizeCacheKey(url)
        cached = force ? null : cacheGet(normalizedUrl)
      } catch {
        cached = null
      }

      const loadContent = async (put?: (value: CachedFetch) => void) => {
        let page: FetchedPage
        if (cached) {
          page = { ...cached, body: cached.content, fromCache: true }
        } else {
          const gate = await checkUrl(url)
          if (!gate.ok) throw new GateError(gate.detail)
          try { page = await fetchWithGate(url, signal) } catch (error) {
            throw new GateError(`抓取失败：${error instanceof Error ? error.message : String(error)}`)
          }
        }
        const extraction = await extractContent(page.body, page.contentType)
        if (extraction.kind === 'js-shell') {
          throw new GateError(`${extraction.detail}。此页需要浏览器渲染，建议告知用户改用浏览器工具查看。`)
        }
        const content = extraction.kind === 'markdown' ? extraction.markdown : extraction.text
        if (mode === 'readable' && content.length > PATHOLOGICAL_MAX_CHARS) {
          throw new GateError(`页面过大（提取后 ${content.length} 字符，上限 ${PATHOLOGICAL_MAX_CHARS}）。建议：改用 extract 提取具体字段，或使用浏览器查看。`)
        }
        if (content.length > 0) put?.({
          finalUrl: page.finalUrl, content: page.body, contentType: page.contentType, fetchedAt: page.fetchedAt
        })
        return { page, extraction, content }
      }
      let loaded: Awaited<ReturnType<typeof loadContent>>
      try {
        loaded = cached ? await loadContent() : await withCacheWrite(normalizedUrl, loadContent)
      } catch (error) {
        return failure(error instanceof Error ? error.message : String(error))
      }
      const { page, extraction, content } = loaded

      const degraded = extraction.kind === 'short-with-warning'
      if (mode === 'readable') {
        return {
          success: true,
          output: formatReadableOutput(page, content, degraded),
          structuredContent: {
            kind: 'readable',
            requestedUrl: url,
            url: page.finalUrl,
            fromCache: page.fromCache,
            fetchedAt: page.fetchedAt,
            content,
            degraded
          }
        }
      }

      if (!fields || !provider) return failure('定向提取器未正确装配')
      const referenceDate = currentExtractionReferenceDate()
      const contentSha256 = createHash('sha256').update(content, 'utf8').digest('hex')
      const cacheKey = JSON.stringify({
        version: 1,
        contentSha256,
        fields: canonicalFieldSpecs(fields),
        provider: provider.cacheKey,
        referenceDate,
        maxEstimatedTokens: provider.maxEstimatedTokens ?? null
      })
      const pendingKey = context.runId
        ? `${context.runId}:${force ? 'force' : 'normal'}:${cacheKey}`
        : undefined
      const pageExtraction = await extractionCache.getOrLoad(
        cacheKey,
        pendingKey,
        force,
        () => extractPageFields(content, fields, provider, signal, referenceDate)
      )

      return {
        // 页面已成功取得；提取失败以结构化 error 返回，脚本可对单页降级而不丢掉其他页面。
        success: true,
        output: formatExtractionOutput(page, pageExtraction),
        structuredContent: {
          kind: 'extract',
          requestedUrl: url,
          url: page.finalUrl,
          fromCache: page.fromCache,
          fetchedAt: page.fetchedAt,
          contentSha256,
          extraction: pageExtraction
        }
      }
    }
  }
}

export const webFetchTool = createWebFetchTool()
