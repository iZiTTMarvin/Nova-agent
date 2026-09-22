import {
  browserNotApplied,
  formatBrowserViewport,
  type BrowserAuthority,
  type BrowserNotApplied,
  type BrowserPageProjection,
  type BrowserSurfaceSnapshot,
  type BrowserUnknownOutcome,
  type BrowserObservationProjection
} from '../../shared/browser'
import type { BrowserCommandContext, BrowserPort } from './index'
import type { ToolContext, ToolResult } from '../tools/types'

export interface BrowserToolDeps {
  readonly getPort: () => BrowserPort | null
}

export function unavailablePort(): ToolResult {
  return failApplied(browserNotApplied('unavailable', '内置浏览器尚未装配'))
}

export function requireBrowserPort(getPort: () => BrowserPort | null): BrowserPort | null {
  return getPort()
}

export function resolveBrowserCommandContext(
  context: ToolContext
): { readonly ok: true; readonly value: BrowserCommandContext } | { readonly ok: false; readonly result: ToolResult } {
  const sessionId = context.sessionId?.trim()
  if (!sessionId) {
    return {
      ok: false,
      result: failApplied(browserNotApplied('invalid_request', '缺少会话身份，无法操作内置浏览器'))
    }
  }
  const authority = buildAuthority(context, sessionId)
  return {
    ok: true,
    value: {
      sessionId,
      ...(authority ? { authority } : {}),
      ...(context.abortSignal ? { abortSignal: context.abortSignal } : {})
    }
  }
}

export function buildAuthority(context: ToolContext, sessionId: string): BrowserAuthority | undefined {
  const runId = context.runId?.trim()
  const resourceOwnerRunId = context.resourceOwnerRunId?.trim()
  const toolCallId = context.invocationRef?.toolCallId?.trim()
  if (!runId || !resourceOwnerRunId || !toolCallId) return undefined
  return { sessionId, runId, resourceOwnerRunId, toolCallId }
}

export function parseFail(detail: string): ToolResult {
  return failApplied(browserNotApplied('invalid_request', detail))
}

export function failApplied(result: BrowserNotApplied): ToolResult {
  return {
    success: false,
    output: '',
    error: `[${result.code}] ${result.detail}`
  }
}

export function failUnknown(result: BrowserUnknownOutcome): ToolResult {
  return {
    success: false,
    output: '',
    error: `[outcome_unknown] ${result.detail}。不要重放该动作，请重新观察页面。`
  }
}

export function formatPage(page: BrowserPageProjection): string {
  const lines = [
    `browserId: ${page.browserId}`,
    `generation: ${page.generation}`,
    `documentEpoch: ${page.documentEpoch}`,
    `url: ${page.url}`,
    `title: ${page.title}`,
    `lifecycle: ${page.lifecycle}`,
    `control: ${page.control.holder}`
  ]
  if (page.loadError) {
    lines.push(`loadError: ${page.loadError.message}`)
  }
  return lines.join('\n')
}

export function formatList(snapshot: BrowserSurfaceSnapshot): string {
  if (snapshot.pages.length === 0) {
    return '当前任务没有打开的页面。'
  }
  const pages = snapshot.pages.map((page, index) => {
    const active = page.browserId === snapshot.activeBrowserId ? '（当前）' : ''
    return `${index + 1}. ${page.title || page.url} ${active}\n${formatPage(page)}`
  })
  return `打开的页面（最多 ${snapshot.maxLivePages} 个）：\n\n${pages.join('\n\n')}`
}

export function formatObservation(
  observation: {
    readonly browserId: string
    readonly generation: number
    readonly documentEpoch: number
    readonly observationId: string
  },
  snapshot: BrowserObservationProjection
): string {
  const limits = snapshot.limits.length > 0 ? snapshot.limits.join(', ') : 'none'
  const elements = snapshot.elements
    .map((item) => `- ${item.ref}  ${item.role}  ${item.name}`)
    .join('\n')
  return [
    `observationId: ${observation.observationId}`,
    `browserId: ${observation.browserId}`,
    `generation: ${observation.generation}`,
    `documentEpoch: ${observation.documentEpoch}`,
    `url: ${snapshot.url}`,
    `title: ${snapshot.title}`,
    `viewport: ${formatBrowserViewport(snapshot.viewport)}`,
    `truncated: ${snapshot.truncated ? 'yes' : 'no'}`,
    `limits: ${limits}`,
    '',
    'dom:',
    snapshot.dom,
    '',
    'elements:',
    elements || '(none)'
  ].join('\n')
}
