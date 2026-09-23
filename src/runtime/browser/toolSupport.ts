import {
  browserNotApplied,
  formatBrowserViewport,
  type BrowserAuthority,
  type BrowserErrorCode,
  type BrowserNotApplied,
  type BrowserPageProjection,
  type BrowserSurfaceSnapshot,
  type BrowserUnknownOutcome,
  type BrowserObservationProjection,
  type ObservationIdentity
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

/** 失败时告诉模型下一步怎么做，避免它原样重放同一调用。 */
const RECOVERY_HINTS: Partial<Record<BrowserErrorCode, string>> = {
  stale_observation: '页面已变化：先 browser_observe snapshot 取得新的 observation 再操作',
  taken_over: '用户正在操作这个页面：等用户交还后重新观察，或先询问用户',
  target_missing: '目标已不在页面上：重新 browser_observe snapshot，改用新快照里的 ref',
  target_ambiguous: '目标不唯一：重新观察后换一个更具体的 ref',
  target_occluded: '目标被遮挡：先关闭遮挡的弹层或滚动页面，再重新观察',
  page_closed: '页面已关闭：用 browser_observe list 查看现有页面，或重新 open',
  not_owner: '这个 browserId 不属于当前会话：用 browser_observe list 查看可用页面',
  busy: '这个页面还有命令在执行：等上一条完成后再试'
}

export function failApplied(result: BrowserNotApplied): ToolResult {
  const hint = RECOVERY_HINTS[result.code]
  return {
    success: false,
    output: '',
    error: hint ? `[${result.code}] ${result.detail}。${hint}` : `[${result.code}] ${result.detail}`
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
  return [
    `打开的页面（最多 ${snapshot.maxLivePages} 个）：`,
    pages.join('\n\n'),
    '读取某个页面：browser_observe {"action":"snapshot","browserId":"<上面的 browserId>"}'
  ].join('\n\n')
}

/** browser_act / browser_capture 共用的 observation 参数 schema。 */
export function observationParameterSchema(): Record<string, unknown> {
  return {
    type: 'object',
    description: '原样复制最近一次 browser_observe snapshot 返回的 observation 行',
    properties: {
      browserId: { type: 'string' },
      generation: { type: 'integer', minimum: 1 },
      documentEpoch: { type: 'integer', minimum: 1 },
      observationId: { type: 'string' }
    },
    required: ['browserId', 'generation', 'documentEpoch', 'observationId'],
    additionalProperties: false
  }
}

/** 可直接复制进 browser_act / browser_capture 的观察身份 JSON。 */
export function formatObservationArg(observation: ObservationIdentity): string {
  return JSON.stringify({
    browserId: observation.browserId,
    generation: observation.generation,
    documentEpoch: observation.documentEpoch,
    observationId: observation.observationId
  })
}

export function formatObservation(
  observation: ObservationIdentity,
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
    `observation: ${formatObservationArg(observation)}`,
    '（browser_act / browser_capture 原样传上一行 observation；ref 取自下方 dom）',
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
