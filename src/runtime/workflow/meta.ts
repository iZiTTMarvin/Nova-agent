/**
 * 解析编排脚本的 `export const meta = { ... }` 字面量。
 * 递归下降只接受纯数据（对象/数组/字符串/数字/布尔/null），绝不 eval。
 * 恶意 meta（函数调用、属性访问等）一律解析失败。
 */
import type { WorkflowMeta } from './types'

export type ParseResult =
  | { ok: true; meta: WorkflowMeta; body: string }
  | { ok: false; error: string }

const META_START_RE = /export\s+const\s+meta\s*=\s*/

export function parseMeta(script: string): ParseResult {
  const start = META_START_RE.exec(script)
  if (!start) {
    return { ok: false, error: 'workflow script must start with `export const meta = { ... }`' }
  }
  const open = script.indexOf('{', start.index + start[0].length)
  if (open === -1) {
    return { ok: false, error: 'workflow script must start with `export const meta = { ... }`' }
  }
  const close = findBalancedClose(script, open)
  if (close === -1) {
    return { ok: false, error: 'could not locate a balanced meta object literal' }
  }
  const literal = script.slice(open, close + 1)
  const parsed = parseDataLiteral(literal)
  if (!parsed.ok) return { ok: false, error: `meta is not a valid object literal: ${parsed.error}` }
  const meta = parsed.value
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) {
    return { ok: false, error: 'meta must be an object' }
  }
  const m = meta as Record<string, unknown>
  if (typeof m.name !== 'string' || !m.name) {
    return { ok: false, error: 'meta.name (non-empty string) is required' }
  }
  if (typeof m.description !== 'string' || !m.description) {
    return { ok: false, error: 'meta.description (non-empty string) is required' }
  }
  // 用等长空白替换 meta 语句，保留行号便于脚本栈追踪
  const endIndex = close + 1 + (script[close + 1] === ';' ? 1 : 0)
  const matched = script.slice(start.index, endIndex)
  const body = script.slice(0, start.index) + matched.replace(/[^\n]/g, ' ') + script.slice(endIndex)
  const workflowMeta: WorkflowMeta = {
    name: m.name as string,
    description: m.description as string,
    ...(typeof m.whenToUse === 'string' ? { whenToUse: m.whenToUse } : {}),
    ...(Array.isArray(m.phases) ? { phases: m.phases as WorkflowMeta['phases'] } : {}),
    ...(typeof m.model === 'string' ? { model: m.model } : {})
  }
  return { ok: true, meta: workflowMeta, body }
}

/** 从 `{` 起找配对 `}`，忽略字符串与注释内的括号 */
function findBalancedClose(script: string, open: number): number {
  let depth = 0
  let quote = ''
  for (let i = open; i < script.length; i++) {
    const ch = script[i]
    if (quote) {
      if (ch === '\\') {
        i++
        continue
      }
      if (ch === quote) quote = ''
      continue
    }
    if (ch === '/' && script[i + 1] === '/') {
      i += 2
      while (i < script.length && script[i] !== '\n') i++
      continue
    }
    if (ch === '/' && script[i + 1] === '*') {
      i += 2
      while (i < script.length && !(script[i] === '*' && script[i + 1] === '/')) i++
      i++
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch
      continue
    }
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

type DataResult = { ok: true; value: unknown } | { ok: false; error: string }

const MAX_DEPTH = 100

function parseDataLiteral(text: string): DataResult {
  const reader = { text, pos: 0, depth: 0 }
  try {
    skipTrivia(reader)
    const value = readValue(reader)
    skipTrivia(reader)
    if (reader.pos !== reader.text.length) {
      throw new ParseFail(`unexpected token at offset ${reader.pos}`)
    }
    return { ok: true, value }
  } catch (e) {
    if (e instanceof ParseFail) return { ok: false, error: e.message }
    throw e
  }
}

class ParseFail extends Error {}

type Reader = { text: string; pos: number; depth: number }

function skipTrivia(r: Reader): void {
  for (;;) {
    const ch = r.text[r.pos]
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v') {
      r.pos++
      continue
    }
    if (ch === '/' && r.text[r.pos + 1] === '/') {
      r.pos += 2
      while (r.pos < r.text.length && r.text[r.pos] !== '\n') r.pos++
      continue
    }
    if (ch === '/' && r.text[r.pos + 1] === '*') {
      r.pos += 2
      while (r.pos < r.text.length && !(r.text[r.pos] === '*' && r.text[r.pos + 1] === '/')) r.pos++
      if (r.pos >= r.text.length) throw new ParseFail('unterminated comment')
      r.pos += 2
      continue
    }
    return
  }
}

function readValue(r: Reader): unknown {
  const ch = r.text[r.pos]
  if (ch === undefined) throw new ParseFail('unexpected end of input')
  if (ch === '{') return readObject(r)
  if (ch === '[') return readArray(r)
  if (ch === '"' || ch === "'") return readString(r)
  if (ch === '-' || (ch >= '0' && ch <= '9')) return readNumber(r)
  if (matchKeyword(r, 'true')) return true
  if (matchKeyword(r, 'false')) return false
  if (matchKeyword(r, 'null')) return null
  throw new ParseFail(`unexpected token at offset ${r.pos} (only data literals are allowed)`)
}

function readObject(r: Reader): Record<string, unknown> {
  if (++r.depth > MAX_DEPTH) throw new ParseFail('meta nesting too deep')
  r.pos++
  const obj: Record<string, unknown> = {}
  skipTrivia(r)
  if (r.text[r.pos] === '}') {
    r.pos++
    r.depth--
    return obj
  }
  for (;;) {
    skipTrivia(r)
    const key = readKey(r)
    skipTrivia(r)
    if (r.text[r.pos] !== ':') {
      throw new ParseFail(`expected ':' after key '${key}' at offset ${r.pos}`)
    }
    r.pos++
    skipTrivia(r)
    obj[key] = readValue(r)
    skipTrivia(r)
    const sep = r.text[r.pos]
    if (sep === ',') {
      r.pos++
      skipTrivia(r)
      if (r.text[r.pos] === '}') {
        r.pos++
        r.depth--
        return obj
      }
      continue
    }
    if (sep === '}') {
      r.pos++
      r.depth--
      return obj
    }
    throw new ParseFail(`expected ',' or '}' at offset ${r.pos}`)
  }
}

function readArray(r: Reader): unknown[] {
  if (++r.depth > MAX_DEPTH) throw new ParseFail('meta nesting too deep')
  r.pos++
  const arr: unknown[] = []
  skipTrivia(r)
  if (r.text[r.pos] === ']') {
    r.pos++
    r.depth--
    return arr
  }
  for (;;) {
    skipTrivia(r)
    arr.push(readValue(r))
    skipTrivia(r)
    const sep = r.text[r.pos]
    if (sep === ',') {
      r.pos++
      skipTrivia(r)
      if (r.text[r.pos] === ']') {
        r.pos++
        r.depth--
        return arr
      }
      continue
    }
    if (sep === ']') {
      r.pos++
      r.depth--
      return arr
    }
    throw new ParseFail(`expected ',' or ']' at offset ${r.pos}`)
  }
}

function readKey(r: Reader): string {
  const ch = r.text[r.pos]
  if (ch === '"' || ch === "'") return readString(r)
  if (ch !== undefined && /[A-Za-z_$]/.test(ch)) {
    const startPos = r.pos
    r.pos++
    while (r.pos < r.text.length && /[A-Za-z0-9_$]/.test(r.text[r.pos])) r.pos++
    return r.text.slice(startPos, r.pos)
  }
  throw new ParseFail(`expected a property name at offset ${r.pos}`)
}

function readString(r: Reader): string {
  const quote = r.text[r.pos]
  r.pos++
  let out = ''
  for (;;) {
    const ch = r.text[r.pos]
    if (ch === undefined || ch === '\n') throw new ParseFail('unterminated string')
    if (ch === '\\') {
      const esc = r.text[r.pos + 1]
      r.pos += 2
      if (esc === 'n') out += '\n'
      else if (esc === 't') out += '\t'
      else if (esc === 'r') out += '\r'
      else if (esc === 'b') out += '\b'
      else if (esc === 'f') out += '\f'
      else if (esc === 'v') out += '\v'
      else if (esc === '0') out += '\0'
      else if (esc === 'u') {
        const hex = r.text.slice(r.pos, r.pos + 4)
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new ParseFail('invalid \\u escape')
        out += String.fromCharCode(parseInt(hex, 16))
        r.pos += 4
      } else if (esc === undefined) throw new ParseFail('unterminated string')
      else out += esc
      continue
    }
    if (ch === quote) {
      r.pos++
      return out
    }
    out += ch
    r.pos++
  }
}

function readNumber(r: Reader): number {
  const startPos = r.pos
  if (r.text[r.pos] === '-') r.pos++
  while (r.pos < r.text.length && /[0-9]/.test(r.text[r.pos])) r.pos++
  if (r.text[r.pos] === '.') {
    r.pos++
    while (r.pos < r.text.length && /[0-9]/.test(r.text[r.pos])) r.pos++
  }
  if (r.text[r.pos] === 'e' || r.text[r.pos] === 'E') {
    r.pos++
    if (r.text[r.pos] === '+' || r.text[r.pos] === '-') r.pos++
    while (r.pos < r.text.length && /[0-9]/.test(r.text[r.pos])) r.pos++
  }
  const raw = r.text.slice(startPos, r.pos)
  const n = Number(raw)
  if (!Number.isFinite(n)) throw new ParseFail(`invalid number '${raw}'`)
  return n
}

function matchKeyword(r: Reader, word: string): boolean {
  if (r.text.startsWith(word, r.pos)) {
    const after = r.text[r.pos + word.length]
    if (after === undefined || !/[A-Za-z0-9_$]/.test(after)) {
      r.pos += word.length
      return true
    }
  }
  return false
}
