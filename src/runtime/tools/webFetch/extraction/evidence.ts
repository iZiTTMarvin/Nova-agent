// 证据定位改写自 pi-web-access（MIT），许可见 THIRD_PARTY_NOTICES.md。
import type { FieldResult, FieldSpec, SourceEvidence } from './types'

const MAX_LINE_CHARS = 200
const MAX_LINK_TARGET_CHARS = 2_048
const SEPARATORS = new Set([',', '.', ' ', ' ', ' ', "'"])
const isDigit = (char: string | undefined): boolean =>
  char !== undefined && char >= '0' && char <= '9'

interface Comparable {
  text: string
  map: number[]
}

interface PageLines {
  raw: string
  lines: string[]
  starts: number[]
  whole: Comparable[]
}

function closingParens(line: string): Map<number, number> {
  const close = new Map<number, number>()
  const open: number[] = []
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '(') open.push(i)
    else if (line[i] === ')' && open.length > 0) {
      const start = open.pop()!
      if (i - start <= MAX_LINK_TARGET_CHARS) close.set(start, i)
    }
  }
  return close
}

/**
 * 同时保留规范化文本与原文下标，证据才能指回真实页面行。
 * Markdown 标记、链接目标、空白和常见 Unicode 变体只影响匹配，不改变返回的原文。
 */
function comparable(raw: string, visible: boolean): Comparable {
  const close = visible ? closingParens(raw) : undefined
  let text = ''
  const map: number[] = []
  let space = false
  const emit = (chars: string, at: number): void => {
    const folded = chars.normalize('NFKC')
    for (const char of folded.length > 4 * chars.length ? chars : folded) {
      const plain = /[‘’‚‛′]/.test(char)
        ? "'"
        : /[“”„‟″]/.test(char)
          ? '"'
          : /[‐-―]/.test(char)
            ? '-'
            : char
      if (/[*_`[\]]/.test(plain)) continue
      if (/\s/.test(plain)) {
        if (text && !space) {
          text += ' '
          map.push(at)
          space = true
        }
        continue
      }
      const lower = plain.toLowerCase()
      text += lower
      if (lower) space = false
      for (let unit = 0; unit < lower.length; unit++) map.push(at)
    }
  }
  for (let i = 0; i < raw.length;) {
    if (raw[i] === '\\' && i + 1 < raw.length && /[!-/:-@[-`{-~]/.test(raw[i + 1])) {
      emit(raw[i + 1], i + 1)
      i += 2
      continue
    }
    const target = close && raw[i] === ']' && raw[i + 1] === '('
      ? close.get(i + 1)
      : undefined
    if (target !== undefined) {
      i = target + 1
      continue
    }
    let next = i + String.fromCodePoint(raw.codePointAt(i)!).length
    while (next < raw.length && /\p{M}/u.test(String.fromCodePoint(raw.codePointAt(next)!))) {
      next += raw.codePointAt(next)! > 0xffff ? 2 : 1
    }
    emit(raw.slice(i, next), i)
    i = next
  }
  if (space) {
    text = text.slice(0, -1)
    map.pop()
  }
  return { text, map }
}

function indexLines(page: string): PageLines {
  const lines = page.split('\n')
  let offset = 0
  const starts = lines.map(line => {
    const start = offset
    offset += line.length + 1
    return start
  })
  const visible = comparable(page, true)
  const whole = page.includes('](') ? [visible, comparable(page, false)] : [visible]
  return { raw: page, lines, starts, whole }
}

function cite(line: string, lineNumber: number, start: number, end: number): SourceEvidence {
  if (line.length <= MAX_LINE_CHARS) {
    return { line: lineNumber, text: line.replace(/\s+/g, ' ').trim() }
  }
  const size = MAX_LINE_CHARS - 2
  const from = Math.max(
    0,
    Math.min(
      line.length - size,
      end - start >= size ? start : start - Math.floor((size - (end - start)) / 2)
    )
  )
  return {
    line: lineNumber,
    text: `${from > 0 ? '…' : ''}${line.slice(from, from + size).replace(/\s+/g, ' ').trim()}${from + size < line.length ? '…' : ''}`
  }
}

function locateText(value: string, page: PageLines): SourceEvidence | 'ambiguous' | undefined {
  const wanted = comparable(value, false).text
  if (!wanted) return undefined
  let match: { start: number; end: number } | undefined
  for (const form of page.whole) {
    for (let at = form.text.indexOf(wanted); at !== -1; at = form.text.indexOf(wanted, at + 1)) {
      const start = form.map[at]
      const end = form.map[at + wanted.length - 1] + 1
      // 可见文本与原始 Markdown 的同一位置只计一次。
      if (match && (match.start !== start || match.end !== end)) return 'ambiguous'
      match = { start, end }
    }
  }
  if (!match) return undefined
  let lineIndex = 0
  while (lineIndex + 1 < page.starts.length && page.starts[lineIndex + 1] <= match.start) lineIndex++
  const from = page.starts[lineIndex]
  const nextLine = page.raw.indexOf('\n', match.end)
  const to = nextLine === -1 ? page.raw.length : nextLine
  return cite(page.raw.slice(from, to), lineIndex + 1, match.start - from, match.end - from)
}

function readings(groups: string[], separators: string[]): number[] {
  const thousands = (parts: string[]): boolean => parts.slice(1).every(part => part.length === 3)
  const values: number[] = []
  if (thousands(groups) && !(groups.length === 2 && groups[0] === '0')) values.push(Number(groups.join('')))
  const decimal = separators.at(-1)
  if (
    (decimal === '.' || decimal === ',') &&
    separators.slice(0, -1).every(separator => separator !== decimal) &&
    thousands(groups.slice(0, -1))
  ) {
    values.push(Number(`${groups.slice(0, -1).join('')}.${groups.at(-1)}`))
  }
  return values
}

function isWordChar(char: string | undefined): boolean {
  return char !== undefined && /[\p{L}\p{N}]/u.test(char) &&
    !/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(char)
}

/** 数字两侧不能是标识符或日期/版本号片段；货币符号与正负号不属于标识符。 */
function hasNumericBoundary(line: string, start: number, end: number): boolean {
  const before = line[start - 1] ?? ''
  const after = line[end] ?? ''
  if (isWordChar(before) || isWordChar(after)) return false
  if ((before === '-' || before === '−') && isWordChar(line[start - 2])) return false
  if ((after === '-' || after === '−') && isWordChar(line[end + 1])) return false
  return true
}

/** 数字必须匹配完整数值，不能把 299 错配到 1 299 或版本号片段中。 */
function locateNumber(value: number, lines: string[]): SourceEvidence | 'ambiguous' | undefined {
  let match: SourceEvidence | undefined
  for (const [lineIndex, line] of lines.entries()) {
    for (let i = 0; i < line.length;) {
      if (!isDigit(line[i])) {
        i++
        continue
      }
      const groups: string[] = []
      const separators: string[] = []
      let end = i
      for (;;) {
        const from = end
        while (isDigit(line[end])) end++
        groups.push(line.slice(from, end))
        if (!SEPARATORS.has(line[end]) || !isDigit(line[end + 1])) break
        separators.push(line[end])
        end++
      }
      const prefix = i - 1
      const hasCurrency = /[$€£¥]/.test(line[prefix] ?? '')
      const sign = hasCurrency ? prefix - 1 : prefix
      const negative = (line[sign] === '-' || line[sign] === '−') &&
        !isWordChar(line[sign - 1])
      const candidates = new Set(readings(groups, separators))
      const matches = [...candidates].some(reading => (negative ? -reading : reading) === value)
      if (matches && hasNumericBoundary(line, hasCurrency ? prefix : i, end)) {
        if (match || candidates.size > 1) return 'ambiguous'
        match = cite(line, lineIndex + 1, negative ? sign : i, end)
      }
      i = end
    }
  }
  return match
}

/**
 * 文本和数字必须能在页面中核对；无法核对的正式值降级为 guess。
 * 日期、时长和列表可能被模型规范化，只在能精确命中时附证据，不因缺少单行匹配而误判。
 */
export function attachEvidence(
  spec: FieldSpec,
  result: FieldResult,
  page: () => PageLines
): FieldResult {
  if (result.status === 'null') return result
  const value = result.status === 'extracted' ? result.value : result.guess
  if (spec.type === 'number' && typeof value === 'number') {
    const located = locateNumber(value, page().lines)
    if (located === 'ambiguous') {
      return result.status === 'extracted'
        ? { status: 'uncertain', guess: result.value, confidence: result.confidence }
        : result
    }
    if (located) return { ...result, evidence: located }
    if (result.status === 'extracted') {
      return {
        status: 'uncertain',
        guess: result.value,
        confidence: result.confidence,
        notFound: true
      }
    }
    return result
  }
  if (typeof value === 'string' && ['text', 'date', 'time', 'datetime'].includes(spec.type)) {
    const located = locateText(value, page())
    if (located === 'ambiguous') {
      return result.status === 'extracted'
        ? { status: 'uncertain', guess: result.value, confidence: result.confidence }
        : result
    }
    if (located) return { ...result, evidence: located }
    if (spec.type === 'text' && located === undefined && result.status === 'extracted') {
      return {
        status: 'uncertain',
        guess: result.value,
        confidence: result.confidence,
        notFound: true
      }
    }
  }
  return result
}

export function createPageLines(rawPage: string): () => PageLines {
  let indexed: PageLines | undefined
  return () => indexed ??= indexLines(rawPage)
}
