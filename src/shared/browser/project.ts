/**
 * 把 Host 页面记录投影成跨进程快照字段。
 * 子资源和被取消的导航不进错误态；favicon 只收录可给 img 引用的地址。
 */
import { parseBrowserHttpUrl } from './parse'
import {
  BROWSER_ENGINE_CAPABILITIES,
  type BrowserCapabilityDescriptor,
  type BrowserControlProjection,
  type BrowserLifecycleStatus,
  type BrowserPageLoadError,
  type BrowserPageProjection
} from './types'

/** Chromium ERR_ABORTED：被后续导航打断，不是用户可见的加载失败。 */
export const BROWSER_ERR_ABORTED = -3

/** Chromium 证书错误码区间（ERR_CERT_COMMON_NAME_INVALID … ERR_CERT_KNOWN_INTERCEPTION_BLOCKED）。 */
export const BROWSER_CERT_ERROR_CODE_MIN = -217
export const BROWSER_CERT_ERROR_CODE_MAX = -200

export interface BrowserPageProjectInput {
  readonly browserId: string
  readonly generation: number
  readonly documentEpoch: number
  readonly sessionId: string
  readonly url: string
  readonly title: string
  readonly loading: boolean
  readonly lifecycle: BrowserLifecycleStatus
  readonly control: BrowserControlProjection
  readonly faviconUrl: string | null
  readonly loadError: BrowserPageLoadError | null
  readonly capabilities?: BrowserCapabilityDescriptor
}

export interface GuestLoadFailureFields {
  readonly errorCode: unknown
  readonly errorDescription: unknown
  readonly validatedURL: unknown
  readonly isMainFrame: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isCertificateBrowserLoadError(code: number): boolean {
  return code >= BROWSER_CERT_ERROR_CODE_MIN && code <= BROWSER_CERT_ERROR_CODE_MAX
}

export function projectFaviconUrl(favicons: unknown): string | null {
  if (!Array.isArray(favicons)) return null
  for (const item of favicons) {
    if (typeof item !== 'string' || item.length === 0) continue
    if (item.startsWith('data:image/')) return item
    if (parseBrowserHttpUrl(item) !== null) return item
  }
  return null
}

export function projectGuestLoadError(input: GuestLoadFailureFields): BrowserPageLoadError | null {
  if (input.isMainFrame !== true) return null
  if (typeof input.errorCode !== 'number' || !Number.isInteger(input.errorCode)) return null
  if (input.errorCode === BROWSER_ERR_ABORTED) return null
  const message = typeof input.errorDescription === 'string' && input.errorDescription.length > 0
    ? input.errorDescription
    : `加载失败（${input.errorCode}）`
  const url = typeof input.validatedURL === 'string' ? input.validatedURL : ''
  return {
    errorCode: input.errorCode,
    message,
    url,
    isCertificateError: isCertificateBrowserLoadError(input.errorCode)
  }
}

export function readGuestLoadFailureArgs(args: readonly unknown[]): GuestLoadFailureFields {
  const first = args[0]
  if (isRecord(first) && 'errorCode' in first) {
    return {
      errorCode: first.errorCode,
      errorDescription: first.errorDescription,
      validatedURL: first.validatedURL,
      isMainFrame: first.isMainFrame
    }
  }
  return {
    errorCode: args[1],
    errorDescription: args[2],
    validatedURL: args[3],
    isMainFrame: args[4]
  }
}

export function readGuestFaviconArgs(args: readonly unknown[]): unknown {
  const first = args[0]
  if (isRecord(first) && Array.isArray(first.favicons)) return first.favicons
  return args[1]
}

export function projectBrowserPage(input: BrowserPageProjectInput): BrowserPageProjection {
  return {
    browserId: input.browserId,
    generation: input.generation,
    documentEpoch: input.documentEpoch,
    sessionId: input.sessionId,
    url: input.url,
    title: input.title,
    loading: input.loading,
    lifecycle: input.lifecycle,
    control: input.control,
    capabilities: input.capabilities ?? BROWSER_ENGINE_CAPABILITIES,
    faviconUrl: input.faviconUrl,
    loadError: input.loadError
  }
}
