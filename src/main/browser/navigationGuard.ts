/**
 * loadURL 被后一次导航打断时会以 ERR_ABORTED 失败，但新文档可能已经提交。
 * 只有地址等价且 document 已可交互，才把这次拒绝当成导航成功。
 */

const ABORTED_MARK = /\bERR_ABORTED\b|\(-3\)/u

export function isNavigationAborted(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const candidate = error as { code?: unknown; errno?: unknown; message?: unknown }
  if (candidate.code === 'ERR_ABORTED' || candidate.errno === -3) return true
  return typeof candidate.message === 'string' && ABORTED_MARK.test(candidate.message)
}

function normalizedHost(hostname: string): string {
  return hostname.toLowerCase().replace(/^(?:m|www)\./u, '')
}

function normalizedPath(pathname: string): string {
  return pathname.length > 1 ? pathname.replace(/\/+$/u, '') : pathname
}

export function isEquivalentNavigationUrl(requestedUrl: string, currentUrl: string): boolean {
  try {
    const requested = new URL(requestedUrl)
    const current = new URL(currentUrl)
    if (requested.protocol === 'about:' || current.protocol === 'about:') {
      return requested.href === current.href
    }
    return (
      requested.protocol === current.protocol
      && normalizedHost(requested.hostname) === normalizedHost(current.hostname)
      && requested.port === current.port
      && normalizedPath(requested.pathname) === normalizedPath(current.pathname)
      && requested.search === current.search
    )
  } catch {
    return false
  }
}
