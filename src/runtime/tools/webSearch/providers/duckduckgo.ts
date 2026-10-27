/**
 * DuckDuckGo HTML 爬虫 Provider。
 * 进程内串行并限制启动间隔，避免 Code Mode 或多个 Agent 同时请求触发反爬。
 */
import type { SearchProvider, SearchQueryParams, SearchResponse } from '../types'
import { providerError } from './base'
import { parseDdgHtml } from '../scraper/ddgParser'
import { withScraperResponse } from '../scraper/http'

const DDG_SEARCH_URL = 'https://html.duckduckgo.com/html/'
const DDG_COOLDOWN_MS = 10 * 60 * 1000
const DDG_MIN_START_INTERVAL_MS = 2_000
const DDG_TOTAL_TIMEOUT_MS = 8_000

let ddgUnavailableUntil = 0
let ddgNextStartAt = 0
let ddgQueueTail: Promise<void> = Promise.resolve()

export function markDdgUnavailable(): void {
  ddgUnavailableUntil = Date.now() + DDG_COOLDOWN_MS
}

export function resetDdgCooldown(): void {
  ddgUnavailableUntil = 0
  ddgNextStartAt = 0
}

export function isDdgInCooldown(): boolean {
  return Date.now() < ddgUnavailableUntil
}

function isAbortError(err: unknown, signal: AbortSignal): boolean {
  return (
    signal.aborted ||
    (err instanceof Error && err.name === 'AbortError') ||
    (err instanceof DOMException && err.name === 'AbortError')
  )
}

function abortError(): DOMException {
  return new DOMException('请求已取消', 'AbortError')
}

class DdgTimeoutError extends Error {}

function remainingDdg(deadline: number): number {
  const remaining = deadline - Date.now()
  if (remaining <= 0) throw new DdgTimeoutError(`请求超时（${DDG_TOTAL_TIMEOUT_MS}ms）`)
  return remaining
}

/** 等待只放弃当前调用方，不取消其他调用正在进行的请求。 */
async function waitWithAbort<T>(promise: Promise<T>, signal: AbortSignal, deadline: number): Promise<T> {
  if (signal.aborted) throw abortError()
  const timeoutMs = remainingDdg(deadline)
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  try {
    return await new Promise<T>((resolve, reject) => {
      timer = setTimeout(() => reject(new DdgTimeoutError(`请求超时（${DDG_TOTAL_TIMEOUT_MS}ms）`)), timeoutMs)
      onAbort = () => reject(abortError())
      signal.addEventListener('abort', onAbort, { once: true })
      promise.then(resolve, reject)
    })
  } finally {
    if (timer) clearTimeout(timer)
    if (onAbort) signal.removeEventListener('abort', onAbort)
  }
}

async function sleepWithAbort(ms: number, signal: AbortSignal, deadline: number): Promise<void> {
  if (signal.aborted) throw abortError()
  const timeoutMs = remainingDdg(deadline)
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  try {
    await new Promise<void>((resolve, reject) => {
      // 若总 deadline 先于启动间隔结束，定时器必须报超时而不是照常发请求。
      timer = timeoutMs <= ms
        ? setTimeout(() => reject(new DdgTimeoutError(`请求超时（${DDG_TOTAL_TIMEOUT_MS}ms）`)), timeoutMs)
        : setTimeout(resolve, ms)
      onAbort = () => reject(abortError())
      signal.addEventListener('abort', onAbort, { once: true })
    })
  } finally {
    if (timer) clearTimeout(timer)
    if (onAbort) signal.removeEventListener('abort', onAbort)
  }
}

async function serializeDdg<T>(task: () => Promise<T>, signal: AbortSignal, deadline: number): Promise<T> {
  const previous = ddgQueueTail
  let release!: () => void
  const tail = new Promise<void>(resolve => { release = resolve })
  // 当前等待者即使取消，后续请求仍需等前序请求完成，不能穿透队列。
  ddgQueueTail = previous.then(() => tail)
  try {
    await waitWithAbort(previous, signal, deadline)
    const waitMs = Math.max(0, ddgNextStartAt - Date.now())
    if (waitMs > 0) await sleepWithAbort(waitMs, signal, deadline)
    remainingDdg(deadline)
    signal.throwIfAborted()
    ddgNextStartAt = Date.now() + DDG_MIN_START_INTERVAL_MS
    return await task()
  } finally {
    release()
  }
}

export const duckduckgoProvider: SearchProvider = {
  name: 'duckduckgo',

  isAvailable(): boolean {
    return !isDdgInCooldown()
  },

  async search(params: SearchQueryParams, signal: AbortSignal): Promise<SearchResponse> {
    const maxResults = Math.min(params.maxResults ?? 5, 20)
    const body = new URLSearchParams({ q: params.query })
    const deadline = Date.now() + DDG_TOTAL_TIMEOUT_MS

    try {
      return await serializeDdg(async () => {
        let html: string
        try {
          const remainingMs = remainingDdg(deadline)
          html = await withScraperResponse(
            DDG_SEARCH_URL,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: body.toString(),
              timeoutMs: remainingMs,
              signal
            },
            async response => {
              if (!response.ok) {
                throw providerError(
                  'duckduckgo',
                  `HTTP ${response.status}: ${response.statusText}`,
                  response.status
                )
              }
              return await response.text()
            }
          )
        } catch (err) {
          if (isAbortError(err, signal)) throw providerError('duckduckgo', '请求已取消')
          if (err && typeof err === 'object' && 'provider' in err) {
            markDdgUnavailable()
            throw err
          }
          markDdgUnavailable()
          throw providerError('duckduckgo', err instanceof Error ? err.message : String(err))
        }

        const sources = parseDdgHtml(html, maxResults)
        if (sources.length === 0) throw providerError('duckduckgo', '未返回搜索结果')
        return {
          provider: 'duckduckgo',
          sources,
          requestId: crypto.randomUUID()
        }
      }, signal, deadline)
    } catch (err) {
      // 排队或响应清理阶段的取消也统一为 provider 错误，且不进入冷却。
      if (isAbortError(err, signal)) throw providerError('duckduckgo', '请求已取消')
      if (err instanceof DdgTimeoutError) {
        throw providerError('duckduckgo', err.message)
      }
      throw err
    }
  }
}
