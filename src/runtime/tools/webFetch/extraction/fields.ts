// 字段协议与结果校验改写自 pi-web-access（MIT），许可见 THIRD_PARTY_NOTICES.md。
import { estimateTextTokens } from '../../../../shared/model/tokenEstimate'
import { isJsonValue, type JsonValue } from '../../../../shared/tools/types'
import { attachEvidence, createPageLines } from './evidence'
import {
  EXTRACTION_TIMEOUT_MS,
  MAX_EXTRACTION_FIELDS,
  MAX_EXTRACTION_PAGE_CHARS,
  type FieldExtractionProvider,
  type FieldResult,
  type FieldSpec,
  type PageExtraction
} from './types'

const EXTRACT_THRESHOLD = 0.8
const DURATION_UNITS = ['seconds', 'minutes', 'hours', 'days', 'weeks', 'months', 'years']
const MAX_SHOWN_VALUE_CHARS = 1_000
const MAX_FIELD_DEFINITION_CHARS = 600

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseExtractFields(fields: unknown): Record<string, FieldSpec> {
  if (!isRecord(fields)) throw new Error('fields 必须是「字段名 → 类型」对象')
  const entries = Object.entries(fields)
  if (entries.length === 0 || entries.length > MAX_EXTRACTION_FIELDS) {
    throw new Error(`fields 必须包含 1 到 ${MAX_EXTRACTION_FIELDS} 个字段`)
  }
  // 无原型对象让 __proto__、constructor 也能作为普通字段名安全通过。
  const specs: Record<string, FieldSpec> = Object.create(null)
  for (const [name, raw] of entries) {
    if (!/^[A-Za-z0-9_]{1,64}$/.test(name)) {
      throw new Error(`字段名 "${name}" 必须是 1 到 64 位字母、数字或下划线`)
    }
    if (typeof raw !== 'string') {
      throw new Error(`字段 ${name} 必须是 "number" 或 "date: 具体含义" 这类字符串`)
    }
    if (raw.length > MAX_FIELD_DEFINITION_CHARS) {
      throw new Error(`字段 ${name} 的定义不能超过 ${MAX_FIELD_DEFINITION_CHARS} 字符`)
    }
    const colon = raw.indexOf(':')
    const type = (colon === -1 ? raw : raw.slice(0, colon)).trim()
    const instructions = colon === -1 ? '' : raw.slice(colon + 1).trim()
    const [base, sub, extra] = type.split('.')
    let spec: FieldSpec | undefined
    if (sub === undefined && ['text', 'number', 'date', 'time', 'datetime', 'duration'].includes(base)) {
      spec = { type: base as FieldSpec['type'] }
    } else if (sub === undefined && base === 'integer') {
      spec = { type: 'number', integer: true }
    } else if (sub === undefined && base === 'list') {
      spec = { type: 'list', items: 'text' }
    } else if (base === 'duration' && DURATION_UNITS.includes(sub)) {
      spec = { type: 'duration', unit: sub }
    } else if (base === 'list' && (sub === 'number' || sub === 'date')) {
      spec = { type: 'list', items: sub }
    }
    if (!spec || extra !== undefined) {
      throw new Error(`字段 ${name} 的类型 "${type}" 不受支持`)
    }
    specs[name] = instructions ? { ...spec, instructions } : spec
  }
  return specs
}

function realDate(text: string): boolean {
  const [year, month, day] = text.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

function realTime(text: string): boolean {
  const [hours, minutes, seconds = 0] = text.split(':').map(Number)
  return hours <= 23 && minutes <= 59 && seconds <= 59
}

function matchesType(spec: FieldSpec, value: unknown): boolean {
  switch (spec.type) {
    case 'text':
      return typeof value === 'string' && value.trim() !== ''
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) && (!spec.integer || Number.isInteger(value))
    case 'duration':
      return typeof value === 'number' && Number.isFinite(value) && value >= 0
    case 'date':
      return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && realDate(value)
    case 'time':
      return typeof value === 'string' && /^\d{2}:\d{2}(:\d{2})?$/.test(value) && realTime(value)
    case 'datetime': {
      const match = typeof value === 'string'
        ? /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}(?::\d{2})?)(?:\.\d+)?(?:Z|[+-](\d{2}:\d{2}))?$/.exec(value)
        : null
      return match !== null && realDate(match[1]) && realTime(match[2]) &&
        (match[3] === undefined || realTime(match[3]))
    }
    case 'list':
      return Array.isArray(value) && value.every(item => matchesType({ type: spec.items! }, item))
  }
}

function fieldResult(spec: FieldSpec, answer: unknown): FieldResult {
  if (!isRecord(answer)) throw new Error('提取响应缺少字段答案')
  const rawValue = answer.value ?? null
  if (rawValue === null) return { status: 'null' }
  if (!isJsonValue(rawValue)) throw new Error('提取响应包含非 JSON 值')
  const value: JsonValue = rawValue
  const rawConfidence = answer.confidence
  const confidence = typeof rawConfidence === 'number' && Number.isFinite(rawConfidence) &&
    rawConfidence >= 0 && rawConfidence <= 1
    ? rawConfidence
    : undefined
  if (confidence !== undefined && confidence >= EXTRACT_THRESHOLD && matchesType(spec, value)) {
    return { status: 'extracted', value, confidence }
  }
  return {
    status: 'uncertain',
    guess: value,
    ...(confidence !== undefined ? { confidence } : {})
  }
}

export function currentExtractionReferenceDate(): string {
  return new Date().toISOString().slice(0, 10)
}

export function canonicalFieldSpecs(fields: Record<string, FieldSpec>): string {
  return JSON.stringify(Object.keys(fields).sort().map(name => [name, fields[name]]))
}

function truncatePage(page: string, maxEstimatedTokens?: number): { text: string; cut: boolean } {
  const text = page.slice(0, MAX_EXTRACTION_PAGE_CHARS)
  let cut = text.length < page.length
  if (maxEstimatedTokens === undefined || estimateTextTokens(text) <= maxEstimatedTokens) {
    return { text, cut }
  }
  let low = 0
  let high = text.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (estimateTextTokens(text.slice(0, middle)) <= maxEstimatedTokens) low = middle
    else high = middle - 1
  }
  cut = true
  return { text: text.slice(0, low), cut }
}

/**
 * 两种提取 provider 共用同一出口：超时、响应校验、类型检查与证据降级只在这里实现。
 * 调用方取消会向外抛出，不能伪装成一页提取失败而继续主流程。
 */
export async function extractPageFields(
  page: string,
  fields: Record<string, FieldSpec>,
  provider: FieldExtractionProvider,
  signal?: AbortSignal,
  referenceDate = currentExtractionReferenceDate()
): Promise<PageExtraction> {
  const limited = truncatePage(page, provider.maxEstimatedTokens)
  const timeout = AbortSignal.timeout(EXTRACTION_TIMEOUT_MS)
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
  try {
    const response = await provider.extract({
      page: limited.text,
      fields,
      referenceDate,
      signal: combined
    })
    if (!isRecord(response.answers)) throw new Error('提取响应缺少 answers')
    const indexed = createPageLines(limited.text)
    const results = Object.fromEntries(
      Object.entries(fields).map(([name, spec]) => [
        name,
        attachEvidence(spec, fieldResult(spec, Object.hasOwn(response.answers, name) ? response.answers[name] : undefined), indexed)
      ])
    )
    return {
      provider: provider.name,
      fields: results,
      cut: limited.cut || response.truncated === true
    }
  } catch (error) {
    signal?.throwIfAborted()
    if (timeout.aborted) return { provider: provider.name, error: `提取超过 ${EXTRACTION_TIMEOUT_MS / 1000} 秒` }
    return { provider: provider.name, error: error instanceof Error ? error.message : String(error) }
  }
}

function shown(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text.length > MAX_SHOWN_VALUE_CHARS
    ? `${text.slice(0, MAX_SHOWN_VALUE_CHARS)}… [共 ${text.length} 字符]`
    : text
}

export function formatPageExtraction(extraction: PageExtraction): string {
  if ('error' in extraction) return `定向提取失败：${extraction.error}\n`
  const lines = Object.entries(extraction.fields).map(([name, result]) => {
    const evidence = result.status !== 'null' && result.evidence
      ? `；来源第 ${result.evidence.line} 行「${result.evidence.text}」`
      : ''
    if (result.status === 'extracted') {
      return `${name}: ${shown(result.value)}（置信度 ${result.confidence.toFixed(2)}）${evidence}`
    }
    if (result.status === 'uncertain') {
      const confidence = result.confidence !== undefined ? `，置信度 ${result.confidence.toFixed(2)}` : ''
      const notFound = result.notFound ? '；页面中未找到该值' : ''
      return `${name}: 不确定（猜测 ${shown(result.guess)}${confidence}${notFound}）${evidence}`
    }
    return `${name}: 页面未提供`
  })
  if (extraction.cut) lines.push('注意：页面超出提取上下文，本次只读取了前半部分；缺失字段不能据此断定整页不存在。')
  return `${lines.join('\n')}\n`
}
