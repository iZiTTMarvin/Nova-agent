import type { SearchProvider, SearchQueryParams, SearchSource } from '../types'
import { withScraperResponse, readScraperText } from '../scraper/http'
import { providerError } from './base'

const EXA_ENDPOINT = 'https://mcp.exa.ai/mcp'
const EXA_SEARCH_TOOL = 'web_search_advanced_exa'
const MAX_RESPONSE_BYTES = 512 * 1024
let unavailableUntil = 0

function exaError(message: string, statusCode?: number): Error {
  return Object.assign(new Error(message), providerError('exa', message, statusCode))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() && value.trim() !== 'N/A' ? value.trim() : undefined
}

function source(value: unknown): SearchSource | undefined {
  if (!isRecord(value) || !text(value.url)) return undefined
  let url: URL
  try { url = new URL(String(value.url)) } catch { return undefined }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return undefined
  const title = text(value.title) ?? url.hostname
  const snippet = text(value.text) ?? text(value.snippet) ??
    (Array.isArray(value.highlights) ? value.highlights.filter(item => typeof item === 'string').join(' ') : undefined)
  const publishedDate = text(value.publishedDate)
  return {
    title,
    url: url.toString(),
    ...(snippet ? { snippet: snippet.replace(/\s+/g, ' ').slice(0, 1_000) } : {}),
    ...(publishedDate && publishedDate !== 'N/A' ? { publishedDate } : {})
  }
}

function parseResults(raw: string): SearchSource[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw exaError('搜索响应不是合法的结构化来源')
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.results)) throw exaError('搜索响应缺少结构化来源')
  return parsed.results.flatMap(item => source(item) ?? [])
}

function parseEnvelope(body: string): Record<string, unknown> {
  const payloads = [body, ...body.split(/\r?\n\r?\n/).map(event =>
    event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
  )]
  for (const payload of payloads) {
    let value: unknown
    try { value = JSON.parse(payload) } catch { continue }
    if (isRecord(value) && value.jsonrpc === '2.0' && value.id === 1) return value
  }
  throw exaError('搜索服务返回了无法识别的响应')
}

function searchArguments(params: SearchQueryParams): Record<string, string | number | boolean> {
  const args = {
    query: params.query, numResults: Math.min(params.maxResults ?? 5, 20), type: 'auto',
    textMaxCharacters: 1_000, enableHighlights: true
  }
  if (params.recency) {
    const days = { day: 1, week: 7, month: 30, year: 365 }[params.recency]
    return { ...args, startPublishedDate: new Date(Date.now() - days * 86_400_000).toISOString() }
  }
  return args
}

export function resetExaCooldown(): void { unavailableUntil = 0 }

// 只发送搜索词到官方匿名接口，不加载 MCP 运行时或转发页面正文。
export const exaProvider: SearchProvider = {
  name: 'exa',
  isAvailable: () => Date.now() >= unavailableUntil,
  async search(params, signal) {
    const args = searchArguments(params)
    return await withScraperResponse(`${EXA_ENDPOINT}?tools=${EXA_SEARCH_TOOL}`, {
      method: 'POST', signal, timeoutMs: 12_000,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'x-exa-source': 'nova-agent' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: EXA_SEARCH_TOOL, arguments: args } })
    }, async response => {
      if (!response.ok) {
        if (response.status === 429) {
          const retry = response.headers.get('retry-after')
          const seconds = retry && /^\d+$/.test(retry) ? Number(retry) : NaN
          const delay = Number.isFinite(seconds) ? seconds * 1_000 : retry ? Date.parse(retry) - Date.now() : 60_000
          unavailableUntil = Date.now() + Math.min(600_000, Math.max(1_000, Number.isFinite(delay) ? delay : 60_000))
        }
        throw exaError(`搜索服务 HTTP ${response.status}`, response.status)
      }
      const envelope = parseEnvelope(await readScraperText(response, MAX_RESPONSE_BYTES, body => {
        try { parseEnvelope(body); return true } catch { return false }
      }))
      if (isRecord(envelope.error)) throw exaError(text(envelope.error.message)?.slice(0, 300) ?? '搜索协议错误')
      const result = envelope.result
      if (!isRecord(result) || !Array.isArray(result.content)) throw exaError('搜索响应缺少结果')
      if (result.isError === true) {
        unavailableUntil = Date.now() + 60_000
        throw exaError('匿名搜索暂时不可用或达到免费额度')
      }
      const seen = new Set<string>()
      const sources = result.content.flatMap(item =>
        isRecord(item) && item.type === 'text' && typeof item.text === 'string' ? parseResults(item.text) : []
      ).filter(item => {
        if (seen.has(item.url)) return false
        seen.add(item.url)
        return true
      }).slice(0, params.maxResults ?? 5)
      if (!sources.length) throw exaError('搜索未返回可用来源')
      return { provider: 'exa', sources, requestId: crypto.randomUUID() }
    })
  }
}
