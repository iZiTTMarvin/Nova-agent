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

export type BrowserOpenToolArgs =
  | { readonly action: 'open'; readonly url: string }
  | { readonly action: 'url'; readonly browserId: string; readonly url: string }
  | { readonly action: 'back'; readonly browserId: string }
  | { readonly action: 'forward'; readonly browserId: string }
  | { readonly action: 'reload'; readonly browserId: string }
  | { readonly action: 'stop'; readonly browserId: string }

export type BrowserObserveToolArgs =
  | { readonly action: 'list' }
  | { readonly action: 'snapshot'; readonly browserId: string }

export type BrowserCloseToolArgs = { readonly browserId: string }

export type BrowserCaptureToolArgs = { readonly observation: ObservationIdentity }

export function parseBrowserOpenToolArgs(input: unknown): BrowserParseResult<BrowserOpenToolArgs> {
  if (!isRecord(input)) return failed('打开命令必须是对象')
  const action = input.action
  if (action === 'open') {
    if (!hasExactKeys(input, ['action', 'url'])) return failed('open 只能包含 action 与 url')
    const url = parseBrowserHttpUrl(input.url)
    if (url === null) return failed('只允许不含用户信息的 http 或 https 地址')
    return { ok: true, value: Object.freeze({ action: 'open', url }) }
  }
  if (action === 'url') {
    if (!hasExactKeys(input, ['action', 'browserId', 'url'])) {
      return failed('url 导航只能包含 action、browserId 与 url')
    }
    const browserId = readNonEmptyString(input, 'browserId')
    const url = parseBrowserHttpUrl(input.url)
    if (browserId === null) return failed('url 导航需要非空 browserId')
    if (url === null) return failed('只允许不含用户信息的 http 或 https 地址')
    return { ok: true, value: Object.freeze({ action: 'url', browserId, url }) }
  }
  if (action === 'back' || action === 'forward' || action === 'reload' || action === 'stop') {
    if (!hasExactKeys(input, ['action', 'browserId'])) {
      return failed(`${action} 只能包含 action 与 browserId`)
    }
    const browserId = readNonEmptyString(input, 'browserId')
    if (browserId === null) return failed(`${action} 需要非空 browserId`)
    return { ok: true, value: Object.freeze({ action, browserId }) }
  }
  return failed('未知的打开或导航动作')
}

export function parseBrowserObserveToolArgs(
  input: unknown
): BrowserParseResult<BrowserObserveToolArgs> {
  if (!isRecord(input)) return failed('观察命令必须是对象')
  const action = input.action
  if (action === 'list') {
    if (!hasExactKeys(input, ['action'])) return failed('list 不能带额外字段')
    return { ok: true, value: Object.freeze({ action: 'list' }) }
  }
  if (action === 'snapshot') {
    if (!hasExactKeys(input, ['action', 'browserId'])) {
      return failed('snapshot 只能包含 action 与 browserId')
    }
    const browserId = readNonEmptyString(input, 'browserId')
    if (browserId === null) return failed('snapshot 需要非空 browserId')
    return { ok: true, value: Object.freeze({ action: 'snapshot', browserId }) }
  }
  return failed('未知的观察动作')
}

export function parseBrowserCloseToolArgs(input: unknown): BrowserParseResult<BrowserCloseToolArgs> {
  if (!isRecord(input) || !hasExactKeys(input, ['browserId'])) {
    return failed('关闭命令只能包含 browserId')
  }
  const browserId = readNonEmptyString(input, 'browserId')
  if (browserId === null) return failed('关闭命令需要非空 browserId')
  return { ok: true, value: Object.freeze({ browserId }) }
}

export function parseBrowserCaptureToolArgs(
  input: unknown
): BrowserParseResult<BrowserCaptureToolArgs> {
  if (!isRecord(input) || !hasExactKeys(input, ['observation'])) {
    return failed('截图命令只能包含 observation')
  }
  const observation = parseObservationIdentity(input.observation)
  if (!observation.ok) return observation
  return { ok: true, value: Object.freeze({ observation: observation.value }) }
}
