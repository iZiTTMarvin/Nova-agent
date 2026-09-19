/**
 * 共享 HTTP 客户端（搜索爬虫与 web_fetch 共用）
 * 使用浏览器 UA，禁止 gzip 编码（避免 Bing 返回空骨架页）
 */

/** 模拟常见桌面浏览器，降低被反爬拦截概率 */
const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/** 默认请求超时（毫秒） */
const DEFAULT_TIMEOUT_MS = 8_000

export interface ScraperFetchOptions {
  /** 外部传入的 AbortSignal（如用户取消） */
  signal?: AbortSignal
  /** 覆盖默认超时 */
  timeoutMs?: number
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  body?: string
}

/**
 * 在受控作用域内完成请求与正文消费；超时和父 signal 持续到消费者结束。
 * 消费者返回或抛错后，未读完的响应正文会立即取消，Response 不会逃逸作用域。
 */
export async function withScraperResponse<T>(
  url: string,
  options: ScraperFetchOptions,
  consume: (response: Response) => Promise<T>
): Promise<T> {
  if (options.signal?.aborted) {
    throw new Error('请求已取消')
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const controller = new AbortController()
  let abortKind: 'parent' | 'timeout' | undefined
  let response: Response | undefined

  const onAbort = (): void => {
    if (controller.signal.aborted) return
    abortKind = 'parent'
    controller.abort()
  }
  options.signal?.addEventListener('abort', onAbort)
  if (options.signal?.aborted) onAbort()

  const timeoutId = setTimeout(() => {
    if (controller.signal.aborted) return
    abortKind = 'timeout'
    controller.abort()
  }, timeoutMs)

  try {
    response = await fetch(url, {
      method: options.method ?? 'GET',
      redirect: 'manual',
      headers: {
        'User-Agent': BROWSER_USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        // 禁止 gzip：Bing 对 gzip 压缩响应可能返回空骨架页
        'Accept-Encoding': 'identity',
        ...options.headers
      },
      body: options.body,
      signal: controller.signal
    })
    return await consume(response)
  } catch (err) {
    if (controller.signal.aborted) {
      if (abortKind === 'parent' || options.signal?.aborted) {
        throw new Error('请求已取消')
      }
      throw new Error(`请求超时（${timeoutMs}ms）`)
    }
    throw err instanceof Error ? err : new Error(String(err))
  } finally {
    if (response?.body && !response.bodyUsed) {
      await response.body.cancel().catch(() => undefined)
    }
    clearTimeout(timeoutId)
    options.signal?.removeEventListener('abort', onAbort)
  }
}

/** 对目标 URL 发起 GET 请求并在受控生命周期内读取 HTML。 */
export async function scraperFetch(
  url: string,
  options: ScraperFetchOptions = {}
): Promise<string> {
  return await withScraperResponse(url, options, async response => {
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`)
    }
    return await response.text()
  })
}
