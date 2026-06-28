/**
 * 共享 HTTP GET 客户端（Bing / DuckDuckGo 爬虫共用）
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
}

/**
 * 对目标 URL 发起 GET 请求，返回 HTML 文本。
 * 超时或网络错误时抛出 Error。
 */
export async function scraperFetch(
  url: string,
  options: ScraperFetchOptions = {}
): Promise<string> {
  // 调用前已中止的外部 signal 不应再发起请求
  if (options.signal?.aborted) {
    throw new Error('请求已取消')
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const controller = new AbortController()

  // 合并外部 signal 与内部超时 signal
  const onAbort = (): void => controller.abort()
  options.signal?.addEventListener('abort', onAbort)

  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': BROWSER_USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        // 禁止 gzip：Bing 对 gzip 压缩响应可能返回空骨架页
        'Accept-Encoding': 'identity'
      },
      signal: controller.signal
    })

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`)
    }

    return await response.text()
  } catch (err) {
    if (controller.signal.aborted) {
      if (options.signal?.aborted) {
        throw new Error('请求已取消')
      }
      throw new Error(`请求超时（${timeoutMs}ms）`)
    }
    throw err instanceof Error ? err : new Error(String(err))
  } finally {
    clearTimeout(timeoutId)
    options.signal?.removeEventListener('abort', onAbort)
  }
}
