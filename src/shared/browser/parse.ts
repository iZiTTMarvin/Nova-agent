import {
  browserNotApplied,
  type BrowserAction,
  type BrowserActCommand,
  type BrowserActIpcParams,
  type BrowserAttachIpcParams,
  type BrowserCaptureIpcParams,
  type BrowserClaimIpcParams,
  type BrowserCloseIpcParams,
  type BrowserNavigateAction,
  type BrowserNavigateIpcParams,
  type BrowserNotApplied,
  type BrowserObserveCommand,
  type BrowserObserveIpcParams,
  type BrowserOpenIpcParams,
  type BrowserSnapshotIpcParams,
  type ObservationIdentity
} from './types'

export type BrowserParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly detail: string }

const MAX_URL_LENGTH = 4096
const VIEWPORT_MIN = 1
const VIEWPORT_MAX = 4096

function failed(detail: string): { ok: false; detail: string } {
  return { ok: false, detail }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(record)
  if (actual.length !== keys.length) return false
  return keys.every((key) => Object.prototype.hasOwnProperty.call(record, key))
}

function readNonEmptyString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

function readIntegerInRange(
  record: Record<string, unknown>,
  key: string,
  min: number,
  max: number
): number | null {
  const value = record[key]
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
    ? value
    : null
}

export function parseBrowserHttpUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_URL_LENGTH) {
    return null
  }
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  if (parsed.username !== '' || parsed.password !== '') return null
  return value
}

export function invalidBrowserRequest(detail: string): BrowserNotApplied {
  return browserNotApplied('invalid_request', detail)
}

export function parseObservationIdentity(input: unknown): BrowserParseResult<ObservationIdentity> {
  if (!isRecord(input) || !hasExactKeys(input, ['browserId', 'generation', 'documentEpoch', 'observationId'])) {
    return failed('观察身份字段不完整或含有多余项')
  }
  const browserId = readNonEmptyString(input, 'browserId')
  const observationId = readNonEmptyString(input, 'observationId')
  const generation = readIntegerInRange(input, 'generation', 1, Number.MAX_SAFE_INTEGER)
  const documentEpoch = readIntegerInRange(input, 'documentEpoch', 1, Number.MAX_SAFE_INTEGER)
  if (browserId === null || observationId === null || generation === null || documentEpoch === null) {
    return failed('观察身份必须包含正整数世代与非空标识')
  }
  return {
    ok: true,
    value: Object.freeze({ browserId, generation, documentEpoch, observationId })
  }
}

export function parseBrowserAction(input: unknown): BrowserParseResult<BrowserAction> {
  if (!isRecord(input)) return failed('动作必须是对象')
  const kind = input.kind
  if (kind === 'click') {
    if (!hasExactKeys(input, ['kind', 'ref'])) return failed('click 只能包含 kind 与 ref')
    const ref = readNonEmptyString(input, 'ref')
    if (ref === null) return failed('click 需要非空 ref')
    return { ok: true, value: Object.freeze({ kind: 'click', ref }) }
  }
  if (kind === 'fill') {
    if (!hasExactKeys(input, ['kind', 'ref', 'text'])) return failed('fill 只能包含 kind、ref 与 text')
    const ref = readNonEmptyString(input, 'ref')
    if (ref === null) return failed('fill 需要非空 ref')
    if (typeof input.text !== 'string') return failed('fill 的 text 必须是字符串')
    return { ok: true, value: Object.freeze({ kind: 'fill', ref, text: input.text }) }
  }
  if (kind === 'select') {
    if (!hasExactKeys(input, ['kind', 'ref', 'values'])) return failed('select 只能包含 kind、ref 与 values')
    const ref = readNonEmptyString(input, 'ref')
    if (ref === null) return failed('select 需要非空 ref')
    if (!Array.isArray(input.values) || input.values.length === 0) {
      return failed('select 需要非空 values')
    }
    if (input.values.some((item) => typeof item !== 'string')) {
      return failed('select 的 values 必须全是字符串')
    }
    return {
      ok: true,
      value: Object.freeze({
        kind: 'select',
        ref,
        values: Object.freeze([...input.values])
      })
    }
  }
  if (kind === 'press') {
    if (!hasExactKeys(input, ['kind', 'ref', 'key'])) return failed('press 只能包含 kind、ref 与 key')
    const ref = readNonEmptyString(input, 'ref')
    const key = readNonEmptyString(input, 'key')
    if (ref === null || key === null) return failed('press 需要非空 ref 与 key')
    return { ok: true, value: Object.freeze({ kind: 'press', ref, key }) }
  }
  if (kind === 'scroll') {
    if (!hasExactKeys(input, ['kind', 'direction', 'amount'])) {
      return failed('scroll 只能包含 kind、direction 与 amount')
    }
    const direction = input.direction
    const amount = input.amount
    if (direction !== 'up' && direction !== 'down') return failed('scroll 的 direction 无效')
    if (amount !== 'page' && amount !== 'half-page') return failed('scroll 的 amount 无效')
    return { ok: true, value: Object.freeze({ kind: 'scroll', direction, amount }) }
  }
  if (kind === 'viewport') {
    if (!hasExactKeys(input, ['kind', 'width', 'height', 'device'])) {
      return failed('viewport 只能包含 kind、width、height 与 device')
    }
    const width = readIntegerInRange(input, 'width', VIEWPORT_MIN, VIEWPORT_MAX)
    const height = readIntegerInRange(input, 'height', VIEWPORT_MIN, VIEWPORT_MAX)
    const device = input.device
    if (width === null || height === null) return failed('viewport 的宽高必须是范围内的整数')
    if (device !== 'desktop' && device !== 'mobile') return failed('viewport 的 device 无效')
    return { ok: true, value: Object.freeze({ kind: 'viewport', width, height, device }) }
  }
  return failed('未知的页面动作')
}

export function parseBrowserNavigateAction(input: unknown): BrowserParseResult<BrowserNavigateAction> {
  if (!isRecord(input)) return failed('导航动作必须是对象')
  const kind = input.kind
  if (kind === 'url') {
    if (!hasExactKeys(input, ['kind', 'url'])) return failed('url 导航只能包含 kind 与 url')
    const url = parseBrowserHttpUrl(input.url)
    if (url === null) return failed('只允许不含用户信息的 http 或 https 地址')
    return { ok: true, value: Object.freeze({ kind: 'url', url }) }
  }
  if (
    kind === 'back'
    || kind === 'forward'
    || kind === 'reload'
    || kind === 'stop'
    || kind === 'accept-popup'
    || kind === 'dismiss-notice'
  ) {
    if (!hasExactKeys(input, ['kind'])) return failed(`${kind} 不能带额外字段`)
    return { ok: true, value: Object.freeze({ kind }) }
  }
  return failed('未知的导航动作')
}

export function parseBrowserActCommand(input: unknown): BrowserParseResult<BrowserActCommand> {
  if (!isRecord(input) || !hasExactKeys(input, ['observation', 'action'])) {
    return failed('操作命令必须包含 observation 与 action')
  }
  const observation = parseObservationIdentity(input.observation)
  if (!observation.ok) return observation
  const action = parseBrowserAction(input.action)
  if (!action.ok) return action
  return {
    ok: true,
    value: Object.freeze({ observation: observation.value, action: action.value })
  }
}

export function parseBrowserObserveCommand(input: unknown): BrowserParseResult<BrowserObserveCommand> {
  if (!isRecord(input) || !hasExactKeys(input, ['browserId'])) {
    return failed('观察命令只能包含 browserId')
  }
  const browserId = readNonEmptyString(input, 'browserId')
  if (browserId === null) return failed('观察命令需要非空 browserId')
  return { ok: true, value: Object.freeze({ browserId }) }
}

function parseSessionBrowserId(
  input: unknown,
  label: string
): BrowserParseResult<{ sessionId: string; browserId: string }> {
  if (!isRecord(input) || !hasExactKeys(input, ['sessionId', 'browserId'])) {
    return failed(`${label} 必须且只能包含 sessionId 与 browserId`)
  }
  const sessionId = readNonEmptyString(input, 'sessionId')
  const browserId = readNonEmptyString(input, 'browserId')
  if (sessionId === null || browserId === null) {
    return failed(`${label} 需要非空 sessionId 与 browserId`)
  }
  return { ok: true, value: Object.freeze({ sessionId, browserId }) }
}

export function parseBrowserOpenIpcParams(input: unknown): BrowserParseResult<BrowserOpenIpcParams> {
  if (!isRecord(input) || !hasExactKeys(input, ['sessionId', 'url'])) {
    return failed('打开命令必须且只能包含 sessionId 与 url')
  }
  const sessionId = readNonEmptyString(input, 'sessionId')
  if (sessionId === null) return failed('打开命令需要非空 sessionId')
  const url = parseBrowserHttpUrl(input.url)
  if (url === null) return failed('只允许不含用户信息的 http 或 https 地址')
  return { ok: true, value: Object.freeze({ sessionId, url }) }
}

export function parseBrowserNavigateIpcParams(
  input: unknown
): BrowserParseResult<BrowserNavigateIpcParams> {
  if (!isRecord(input) || !hasExactKeys(input, ['sessionId', 'browserId', 'action'])) {
    return failed('导航命令必须且只能包含 sessionId、browserId 与 action')
  }
  const sessionId = readNonEmptyString(input, 'sessionId')
  const browserId = readNonEmptyString(input, 'browserId')
  if (sessionId === null || browserId === null) {
    return failed('导航命令需要非空 sessionId 与 browserId')
  }
  const action = parseBrowserNavigateAction(input.action)
  if (!action.ok) return action
  return {
    ok: true,
    value: Object.freeze({ sessionId, browserId, action: action.value })
  }
}

export function parseBrowserCloseIpcParams(input: unknown): BrowserParseResult<BrowserCloseIpcParams> {
  return parseSessionBrowserId(input, '关闭命令')
}

export function parseBrowserClaimIpcParams(input: unknown): BrowserParseResult<BrowserClaimIpcParams> {
  return parseSessionBrowserId(input, '接管命令')
}

export function parseBrowserSnapshotIpcParams(
  input: unknown
): BrowserParseResult<BrowserSnapshotIpcParams> {
  if (!isRecord(input) || !hasExactKeys(input, ['sessionId'])) {
    return failed('快照命令必须且只能包含 sessionId')
  }
  const sessionId = readNonEmptyString(input, 'sessionId')
  if (sessionId === null) return failed('快照命令需要非空 sessionId')
  return { ok: true, value: Object.freeze({ sessionId }) }
}

export function parseBrowserAttachIpcParams(
  input: unknown
): BrowserParseResult<BrowserAttachIpcParams> {
  if (!isRecord(input) || !hasExactKeys(input, ['sessionId', 'browserId', 'webContentsId'])) {
    return failed('挂载上报必须且只能包含 sessionId、browserId 与 webContentsId')
  }
  const sessionId = readNonEmptyString(input, 'sessionId')
  const browserId = readNonEmptyString(input, 'browserId')
  const webContentsId = readIntegerInRange(input, 'webContentsId', 1, Number.MAX_SAFE_INTEGER)
  if (sessionId === null || browserId === null || webContentsId === null) {
    return failed('挂载上报需要非空身份与正整数 webContentsId')
  }
  return { ok: true, value: Object.freeze({ sessionId, browserId, webContentsId }) }
}

export function parseBrowserObserveIpcParams(
  input: unknown
): BrowserParseResult<BrowserObserveIpcParams> {
  return parseSessionBrowserId(input, '观察命令')
}

export function parseBrowserActIpcParams(input: unknown): BrowserParseResult<BrowserActIpcParams> {
  if (!isRecord(input) || !hasExactKeys(input, ['sessionId', 'observation', 'action'])) {
    return failed('操作命令必须且只能包含 sessionId、observation 与 action')
  }
  const sessionId = readNonEmptyString(input, 'sessionId')
  if (sessionId === null) return failed('操作命令需要非空 sessionId')
  const command = parseBrowserActCommand({ observation: input.observation, action: input.action })
  if (!command.ok) return command
  return {
    ok: true,
    value: Object.freeze({
      sessionId,
      observation: command.value.observation,
      action: command.value.action
    })
  }
}

export function parseBrowserCaptureIpcParams(
  input: unknown
): BrowserParseResult<BrowserCaptureIpcParams> {
  if (!isRecord(input) || !hasExactKeys(input, ['sessionId', 'observation'])) {
    return failed('截图命令必须且只能包含 sessionId 与 observation')
  }
  const sessionId = readNonEmptyString(input, 'sessionId')
  if (sessionId === null) return failed('截图命令需要非空 sessionId')
  const observation = parseObservationIdentity(input.observation)
  if (!observation.ok) return observation
  return { ok: true, value: Object.freeze({ sessionId, observation: observation.value }) }
}

/*
 * 工具入参来自模型，和上面来自 Renderer 的 IPC 入参分开处理：
 * 只读取当前 action 用得到的字段，null / 空串按「未提供」处理，其余多填的字段忽略；
 * 取出的值仍交给上面同一套严格校验。报错写明正确写法，让模型下一步就能改对，
 * 而不是带着同样的参数重试。
 */

export type BrowserOpenToolArgs =
  | { readonly action: 'open'; readonly url: string }
  | { readonly action: 'navigate'; readonly browserId: string; readonly url: string }
  | { readonly action: 'back'; readonly browserId: string }
  | { readonly action: 'forward'; readonly browserId: string }
  | { readonly action: 'reload'; readonly browserId: string }
  | { readonly action: 'stop'; readonly browserId: string }

export type BrowserObserveToolArgs =
  | { readonly action: 'list' }
  /** browserId 为 null 时由工具按当前会话的页面推断 */
  | { readonly action: 'snapshot'; readonly browserId: string | null }

export type BrowserCloseToolArgs = { readonly browserId: string }

export type BrowserCaptureToolArgs = { readonly observation: ObservationIdentity }

const OPEN_EXAMPLE = '{"action":"open","url":"https://example.com"}'
const OBSERVATION_EXAMPLE =
  '{"browserId":"brw_…","generation":1,"documentEpoch":1,"observationId":"obs_…"}'
const BAD_TOOL_URL = 'url 必须是 http(s) 地址且不含账号密码，例如 https://example.com'

/** 模型惯用的跳转说法都折叠成 open：带 browserId 在该页跳转，不带则新建页面。 */
const OPEN_ACTIONS: ReadonlySet<string> = new Set(['open', 'navigate', 'goto', 'url', 'visit'])
const NAVIGATION_CONTROLS = ['back', 'forward', 'reload', 'stop'] as const
type NavigationControl = (typeof NAVIGATION_CONTROLS)[number]
const CONTROL_ALIASES: Readonly<Record<string, NavigationControl>> = { refresh: 'reload' }

const URL_WITH_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i
const BARE_HOST = /^(?:\[[0-9a-f:]+\]|[\w-]+(?:\.[\w-]+)*)(?::\d{1,5})?(?:[/?#]|$)/i
const LOOPBACK_HOST = /^(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1\])(?::\d{1,5})?(?:[/?#]|$)/i

function presentValue(record: Record<string, unknown>, key: string): unknown {
  const value = record[key]
  if (value === null || value === undefined) return undefined
  if (typeof value === 'string' && value.trim().length === 0) return undefined
  return value
}

function readToolString(record: Record<string, unknown>, key: string): string | null {
  const value = presentValue(record, key)
  return typeof value === 'string' ? value.trim() : null
}

function readToolInteger(record: Record<string, unknown>, key: string): number | null {
  const value = presentValue(record, key)
  if (typeof value === 'number') return value
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim())
  return null
}

function readToolActionName(record: Record<string, unknown>): string | null | undefined {
  const value = presentValue(record, 'action')
  if (value === undefined) return undefined
  return typeof value === 'string' ? value.trim().toLowerCase() : null
}

/** 补全模型常省略的协议头；本机地址补 http，其余补 https。协议白名单仍由 parseBrowserHttpUrl 把关。 */
function normalizeToolUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed.length === 0) return null
  if (URL_WITH_SCHEME.test(trimmed)) return parseBrowserHttpUrl(trimmed)
  if (!BARE_HOST.test(trimmed)) return null
  const scheme = LOOPBACK_HOST.test(trimmed) ? 'http://' : 'https://'
  return parseBrowserHttpUrl(`${scheme}${trimmed}`)
}

function isNavigationControl(value: string): value is NavigationControl {
  return (NAVIGATION_CONTROLS as readonly string[]).includes(value)
}

export function parseBrowserOpenToolArgs(input: unknown): BrowserParseResult<BrowserOpenToolArgs> {
  if (!isRecord(input)) return failed(`browser_open 的参数必须是对象，例如 ${OPEN_EXAMPLE}`)
  const rawAction = readToolActionName(input)
  if (rawAction === null) return failed(`action 必须是字符串，例如 ${OPEN_EXAMPLE}`)
  const hasUrl = presentValue(input, 'url') !== undefined
  if (rawAction === undefined && !hasUrl) {
    return failed(
      `缺少 action。新建页面用 ${OPEN_EXAMPLE}；导航控制用 {"action":"back","browserId":"<browserId>"}`
    )
  }
  const action = rawAction === undefined ? 'open' : (CONTROL_ALIASES[rawAction] ?? rawAction)
  const browserId = readToolString(input, 'browserId')

  if (OPEN_ACTIONS.has(action)) {
    if (!hasUrl) {
      return failed(
        `open 需要 url。新建页面：${OPEN_EXAMPLE}；在已有页面跳转：{"action":"open","browserId":"<browserId>","url":"https://example.com"}`
      )
    }
    const url = normalizeToolUrl(input.url)
    if (url === null) return failed(BAD_TOOL_URL)
    return browserId === null
      ? { ok: true, value: Object.freeze({ action: 'open', url }) }
      : { ok: true, value: Object.freeze({ action: 'navigate', browserId, url }) }
  }

  if (isNavigationControl(action)) {
    if (browserId === null) {
      return failed(
        `${action} 需要 browserId（见 browser_open 或 browser_observe list 的返回），例如 {"action":"${action}","browserId":"<browserId>"}`
      )
    }
    return { ok: true, value: Object.freeze({ action, browserId }) }
  }

  return failed(
    `未知的 action "${action}"。可选：open（需要 url；带 browserId 时在该页跳转）、back、forward、reload、stop`
  )
}

export function parseBrowserObserveToolArgs(
  input: unknown
): BrowserParseResult<BrowserObserveToolArgs> {
  if (!isRecord(input)) {
    return failed('browser_observe 的参数必须是对象，例如 {"action":"snapshot","browserId":"<browserId>"}')
  }
  const action = readToolActionName(input)
  if (action === 'list') return { ok: true, value: Object.freeze({ action: 'list' }) }
  if (action === undefined || action === 'snapshot') {
    return {
      ok: true,
      value: Object.freeze({ action: 'snapshot', browserId: readToolString(input, 'browserId') })
    }
  }
  return failed(
    '未知的 action。可选：list（列出页面，不需要其它参数）、snapshot（读取页面，配 browserId）'
  )
}

export function parseBrowserCloseToolArgs(input: unknown): BrowserParseResult<BrowserCloseToolArgs> {
  const browserId = isRecord(input) ? readToolString(input, 'browserId') : null
  if (browserId === null) {
    return failed('browser_close 需要 browserId，例如 {"browserId":"<browserId>"}')
  }
  return { ok: true, value: Object.freeze({ browserId }) }
}

/** 观察身份优先读 observation 对象；模型把四个字段平铺在顶层时也接受。 */
function readToolObservation(input: Record<string, unknown>): BrowserParseResult<ObservationIdentity> {
  const source = isRecord(input.observation) ? input.observation : input
  const browserId = readToolString(source, 'browserId')
  const observationId = readToolString(source, 'observationId')
  const generation = readToolInteger(source, 'generation')
  const documentEpoch = readToolInteger(source, 'documentEpoch')
  if (browserId === null || observationId === null || generation === null || documentEpoch === null) {
    return failed(
      `observation 需要 browserId、generation、documentEpoch、observationId 四项，原样复制最近一次 browser_observe snapshot 返回的 observation 行，例如 ${OBSERVATION_EXAMPLE}`
    )
  }
  const parsed = parseObservationIdentity({ browserId, generation, documentEpoch, observationId })
  if (!parsed.ok) return failed(`${parsed.detail}，例如 ${OBSERVATION_EXAMPLE}`)
  return parsed
}

const ACTION_SHAPES: Readonly<Record<BrowserAction['kind'], { fields: readonly string[]; example: string }>> = {
  click: { fields: ['ref'], example: '{"kind":"click","ref":"e3"}' },
  fill: { fields: ['ref', 'text'], example: '{"kind":"fill","ref":"e3","text":"内容"}' },
  select: { fields: ['ref', 'values'], example: '{"kind":"select","ref":"e3","values":["选项"]}' },
  press: { fields: ['ref', 'key'], example: '{"kind":"press","ref":"e3","key":"Enter"}' },
  scroll: { fields: ['direction', 'amount'], example: '{"kind":"scroll","direction":"down","amount":"page"}' },
  viewport: {
    fields: ['width', 'height', 'device'],
    example: '{"kind":"viewport","width":390,"height":844,"device":"mobile"}'
  }
}

function isActionKind(value: string): value is BrowserAction['kind'] {
  return Object.prototype.hasOwnProperty.call(ACTION_SHAPES, value)
}

function coerceActionField(field: string, value: unknown): unknown {
  if (field === 'values' && typeof value === 'string') return [value]
  if ((field === 'width' || field === 'height') && typeof value === 'string' && /^\d+$/.test(value.trim())) {
    return Number(value.trim())
  }
  return value
}

function readToolBrowserAction(input: Record<string, unknown>): BrowserParseResult<BrowserAction> {
  const source = input.action
  const kinds = Object.keys(ACTION_SHAPES).join('、')
  if (!isRecord(source)) {
    return failed(`缺少 action 对象，例如 ${ACTION_SHAPES.click.example}；kind 可选：${kinds}`)
  }
  const rawKind = typeof source.kind === 'string' ? source.kind.trim().toLowerCase() : ''
  if (!isActionKind(rawKind)) return failed(`未知的 action.kind "${rawKind}"，可选：${kinds}`)
  const shape = ACTION_SHAPES[rawKind]
  const picked: Record<string, unknown> = { kind: rawKind }
  for (const field of shape.fields) {
    const value = source[field]
    // fill 的 text 允许空串（清空输入框），所以这里只把 null / undefined 当作缺失
    if (value === null || value === undefined) {
      if (rawKind === 'scroll' && field === 'amount') {
        picked.amount = 'page'
        continue
      }
      return failed(`${rawKind} 需要 ${shape.fields.join('、')}，例如 ${shape.example}`)
    }
    picked[field] = coerceActionField(field, value)
  }
  const parsed = parseBrowserAction(picked)
  if (!parsed.ok) return failed(`${parsed.detail}，例如 ${shape.example}`)
  return parsed
}

export function parseBrowserActToolArgs(input: unknown): BrowserParseResult<BrowserActCommand> {
  if (!isRecord(input)) return failed('browser_act 的参数必须是对象，包含 observation 与 action')
  const observation = readToolObservation(input)
  if (!observation.ok) return observation
  const action = readToolBrowserAction(input)
  if (!action.ok) return action
  return {
    ok: true,
    value: Object.freeze({ observation: observation.value, action: action.value })
  }
}

export function parseBrowserCaptureToolArgs(
  input: unknown
): BrowserParseResult<BrowserCaptureToolArgs> {
  if (!isRecord(input)) {
    return failed(`browser_capture 需要 observation，例如 {"observation":${OBSERVATION_EXAMPLE}}`)
  }
  const observation = readToolObservation(input)
  if (!observation.ok) return observation
  return { ok: true, value: Object.freeze({ observation: observation.value }) }
}
