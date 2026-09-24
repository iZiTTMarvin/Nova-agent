/**
 * 浏览器 IPC：边界校验 unknown 入参后转发给 BrowserPort。
 * 宿主未装配时 fail closed 为 unavailable，不假装页面已存在。
 */
import { handle } from './secureIpc'
import {
  BROWSER_ACT,
  BROWSER_ATTACH,
  BROWSER_CAPTURE,
  BROWSER_CLAIM,
  BROWSER_CLOSE,
  BROWSER_GET_SNAPSHOT,
  BROWSER_NAVIGATE,
  BROWSER_OBSERVE,
  BROWSER_OPEN,
  BROWSER_RELEASE
} from '../../shared/ipc/channels'
import {
  browserNotApplied,
  invalidBrowserRequest,
  parseBrowserActIpcParams,
  parseBrowserAttachIpcParams,
  parseBrowserCaptureIpcParams,
  parseBrowserClaimIpcParams,
  parseBrowserCloseIpcParams,
  parseBrowserNavigateIpcParams,
  parseBrowserObserveIpcParams,
  parseBrowserOpenIpcParams,
  parseBrowserSnapshotIpcParams
} from '../../shared/browser'
import type { BrowserCommandContext, BrowserPort } from '../../runtime/browser'
import type { BrowserSessionHost } from '../browser'

export interface BrowserHandlerDeps {
  readonly getPort: () => BrowserPort | null
  readonly getHost?: () => BrowserSessionHost | null
}

const HOST_UNAVAILABLE = browserNotApplied('unavailable', '浏览器宿主尚未装配')

function contextOf(sessionId: string): BrowserCommandContext {
  return { sessionId }
}

export function registerBrowserHandler(deps: BrowserHandlerDeps): void {
  handle(BROWSER_OPEN, async (_event, raw: unknown) => {
    const parsed = parseBrowserOpenIpcParams(raw)
    if (!parsed.ok) return invalidBrowserRequest(parsed.detail)
    const port = deps.getPort()
    if (!port) return HOST_UNAVAILABLE
    return port.open({ url: parsed.value.url }, contextOf(parsed.value.sessionId))
  })

  handle(BROWSER_NAVIGATE, async (_event, raw: unknown) => {
    const parsed = parseBrowserNavigateIpcParams(raw)
    if (!parsed.ok) return invalidBrowserRequest(parsed.detail)
    const port = deps.getPort()
    if (!port) return HOST_UNAVAILABLE
    return port.navigate(
      { browserId: parsed.value.browserId, action: parsed.value.action },
      contextOf(parsed.value.sessionId)
    )
  })

  handle(BROWSER_CLOSE, async (_event, raw: unknown) => {
    const parsed = parseBrowserCloseIpcParams(raw)
    if (!parsed.ok) return invalidBrowserRequest(parsed.detail)
    const port = deps.getPort()
    if (!port) return HOST_UNAVAILABLE
    return port.close(
      { browserId: parsed.value.browserId },
      contextOf(parsed.value.sessionId)
    )
  })

  handle(BROWSER_GET_SNAPSHOT, async (_event, raw: unknown) => {
    const parsed = parseBrowserSnapshotIpcParams(raw)
    if (!parsed.ok) return invalidBrowserRequest(parsed.detail)
    const port = deps.getPort()
    if (!port) return HOST_UNAVAILABLE
    return port.listPages(
      { sessionId: parsed.value.sessionId },
      contextOf(parsed.value.sessionId)
    )
  })

  handle(BROWSER_CLAIM, async (_event, raw: unknown) => {
    const parsed = parseBrowserClaimIpcParams(raw)
    if (!parsed.ok) return invalidBrowserRequest(parsed.detail)
    const port = deps.getPort()
    if (!port) return HOST_UNAVAILABLE
    return port.claim(
      { browserId: parsed.value.browserId },
      contextOf(parsed.value.sessionId)
    )
  })

  handle(BROWSER_RELEASE, async (_event, raw: unknown) => {
    const parsed = parseBrowserClaimIpcParams(raw)
    if (!parsed.ok) return invalidBrowserRequest(parsed.detail)
    const port = deps.getPort()
    if (!port) return HOST_UNAVAILABLE
    return port.release(
      { browserId: parsed.value.browserId },
      contextOf(parsed.value.sessionId)
    )
  })

  handle(BROWSER_OBSERVE, async (_event, raw: unknown) => {
    const parsed = parseBrowserObserveIpcParams(raw)
    if (!parsed.ok) return invalidBrowserRequest(parsed.detail)
    const port = deps.getPort()
    if (!port) return HOST_UNAVAILABLE
    return port.observe({ browserId: parsed.value.browserId }, contextOf(parsed.value.sessionId))
  })

  handle(BROWSER_ACT, async (_event, raw: unknown) => {
    const parsed = parseBrowserActIpcParams(raw)
    if (!parsed.ok) return invalidBrowserRequest(parsed.detail)
    const port = deps.getPort()
    if (!port) return HOST_UNAVAILABLE
    return port.act(
      { observation: parsed.value.observation, action: parsed.value.action },
      contextOf(parsed.value.sessionId)
    )
  })

  handle(BROWSER_CAPTURE, async (_event, raw: unknown) => {
    const parsed = parseBrowserCaptureIpcParams(raw)
    if (!parsed.ok) return invalidBrowserRequest(parsed.detail)
    const port = deps.getPort()
    if (!port) return HOST_UNAVAILABLE
    return port.capture(
      { observation: parsed.value.observation },
      contextOf(parsed.value.sessionId)
    )
  })

  handle(BROWSER_ATTACH, async (_event, raw: unknown) => {
    const parsed = parseBrowserAttachIpcParams(raw)
    if (!parsed.ok) return invalidBrowserRequest(parsed.detail)
    const sessionHost = deps.getHost?.() ?? null
    if (!sessionHost) return HOST_UNAVAILABLE
    return sessionHost.attach(parsed.value)
  })
}
