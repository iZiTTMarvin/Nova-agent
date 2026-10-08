import { randomInt } from 'node:crypto'
import { TextDecoder } from 'node:util'
import {
  MEMORY_ALIAS_MAX_CHARS, MEMORY_ALIAS_MAX_COUNT, MEMORY_CANDIDATE_CONTENT_MAX_CHARS,
  MEMORY_ENTRY_ID_LENGTH, MEMORY_FORMAT_VERSION, MEMORY_KEY_MAX_CHARS
} from '../memoryConfig'
import { MEMORY_KINDS, type MemoryKind } from '../types'

export const MEMORY_FILE_HEADER = `<!-- nova-memory v${MEMORY_FORMAT_VERSION} -->`
export const MEMORY_GENERATED_HEADER = `<!-- nova-memory v${MEMORY_FORMAT_VERSION} · generated; edit the topic files instead -->`
export const MEMORY_TOPIC_FILES: Readonly<Record<MemoryKind, string>> = {
  preference: 'preferences.md', convention: 'conventions.md', project_fact: 'facts.md',
  decision: 'decisions.md', workflow: 'workflow.md', gotcha: 'gotchas.md'
}
export const MEMORY_TOPIC_TITLES: Readonly<Record<MemoryKind, string>> = {
  preference: '# Preferences', convention: '# Conventions', project_fact: '# Project facts',
  decision: '# Decisions', workflow: '# Workflow', gotcha: '# Gotchas'
}

export type MemoryEntryBy = 'user' | 'verified' | 'observed' | 'inferred'
export interface MemoryEntryMetadata {
  id?: string
  by?: MemoryEntryBy
  added?: string
  seen?: string
  key?: string
  aliases?: string[]
  pin?: '1'
  verify?: '1'
  src?: string
  fp?: string
  kind?: MemoryKind
  status?: 'superseded' | 'retracted'
  until?: string
  by_id?: string
  unknown: Readonly<Record<string, string>>
}
export interface MemoryFileEntry {
  text: string
  metadata: MemoryEntryMetadata
}
export type MemoryFileLine =
  | { type: 'entry'; entry: MemoryFileEntry; raw: string; original: string; eol: string }
  | { type: 'text' | 'invalid'; raw: string; eol: string }
export interface MemoryFileModel {
  lines: MemoryFileLine[]
  newline: '\n' | '\r\n'
  readOnly: boolean
  issues: number
  version: number | null
  hadBom: boolean
}

const KNOWN_KEYS = new Set(['id', 'by', 'added', 'seen', 'key', 'aliases', 'pin', 'verify', 'src', 'fp', 'kind', 'status', 'until', 'by_id'])
const ID_RE = new RegExp(`^m_[0-9a-z]{${MEMORY_ENTRY_ID_LENGTH}}$`)
const BY_VALUES: readonly string[] = ['user', 'verified', 'observed', 'inferred']

export function generateMemoryEntryId(): string {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz'
  return 'm_' + Array.from({ length: MEMORY_ENTRY_ID_LENGTH }, () => alphabet[randomInt(alphabet.length)]).join('')
}

export function localMemoryDate(at: number): string {
  const date = new Date(at)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(value + 'T00:00:00Z')
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}

export function escapeMemoryText(text: string): string {
  return text.replace(/<!--/g, '<!‐‐').replace(/-->/g, '‐‐>')
}

export function unescapeMemoryText(text: string): string {
  return text.replace(/<!‐‐/g, '<!--').replace(/‐‐>/g, '-->')
}

export function encodeMetadataValue(value: string): string {
  return encodeURIComponent(value)
}

function parseMetadata(raw: string): MemoryEntryMetadata | null {
  const values = new Map<string, string>()
  const unknownPairs: [string, string][] = []
  try {
    for (const pair of raw.split(' ')) {
      const match = /^([a-z_]+)=([^\s]+)$/.exec(pair)
      if (!match || values.has(match[1]) || match[2].includes('-->')) return null
      values.set(match[1], match[2])
      if (!KNOWN_KEYS.has(match[1])) unknownPairs.push([match[1], match[2]])
    }
    const decoded: Record<string, string> = {}
    for (const key of KNOWN_KEYS) {
      const value = values.get(key)
      if (value !== undefined) decoded[key] = decodeURIComponent(value)
    }
    if (decoded.id !== undefined && !ID_RE.test(decoded.id)) return null
    if (!BY_VALUES.includes(decoded.by) || !decoded.added || !validDate(decoded.added)) return null
    for (const key of ['seen', 'until']) if (decoded[key] !== undefined && !validDate(decoded[key])) return null
    if (decoded.key !== undefined && (!/^[a-z0-9._-]+$/.test(decoded.key) || decoded.key.length > MEMORY_KEY_MAX_CHARS)) return null
    for (const key of ['pin', 'verify']) if (decoded[key] !== undefined && decoded[key] !== '1') return null
    if (decoded.kind !== undefined && !MEMORY_KINDS.some(kind => kind === decoded.kind)) return null
    if (decoded.status !== undefined && decoded.status !== 'superseded' && decoded.status !== 'retracted') return null
    if (decoded.by_id !== undefined && !ID_RE.test(decoded.by_id)) return null
    if (decoded.fp !== undefined && !/^\d+-\d+(?:\.\d+)?$/.test(decoded.fp)) return null
    const aliases = values.get('aliases')?.split(',').map(value => decodeURIComponent(value))
    if (aliases && (aliases.length > MEMORY_ALIAS_MAX_COUNT || aliases.some(value => !value || value.length > MEMORY_ALIAS_MAX_CHARS || /[\r\n]/.test(value)))) return null
    if (Object.values(decoded).some(value => /[\r\n]/.test(value))) return null
    return {
      id: decoded.id, by: decoded.by as MemoryEntryBy, added: decoded.added,
      seen: decoded.seen, key: decoded.key, aliases,
      pin: decoded.pin as '1' | undefined, verify: decoded.verify as '1' | undefined,
      src: decoded.src, fp: decoded.fp, kind: decoded.kind as MemoryKind | undefined,
      status: decoded.status as 'superseded' | 'retracted' | undefined,
      until: decoded.until, by_id: decoded.by_id, unknown: Object.fromEntries(unknownPairs)
    }
  } catch {
    return null
  }
}

export function parseMemoryEntryLine(line: string): MemoryFileEntry | null {
  if (!line.startsWith('- ') || /[\r\n]/.test(line)) return null
  const match = /^(.*?)  <!-- (.+) -->$/.exec(line.slice(2))
  let metadata: MemoryEntryMetadata = { unknown: {} }
  let text = line.slice(2)
  if (match) {
    text = match[1]
    const parsed = parseMetadata(match[2])
    if (!parsed) return null
    metadata = parsed
  } else if (text.includes('<!--') || text.includes('-->')) {
    return null
  }
  text = unescapeMemoryText(text)
  if (!text.trim() || text.length > MEMORY_CANDIDATE_CONTENT_MAX_CHARS) return null
  return { text, metadata }
}

export function serializeMemoryEntryLine(entry: MemoryFileEntry): string {
  if (!entry.text.trim() || /[\r\n]/.test(entry.text) || entry.text.length > MEMORY_CANDIDATE_CONTENT_MAX_CHARS) {
    throw new Error('Invalid memory entry content')
  }
  const pairs: string[] = []
  for (const key of KNOWN_KEYS) {
    const value = entry.metadata[key as keyof MemoryEntryMetadata]
    if (value === undefined) continue
    if (key === 'aliases' && Array.isArray(value)) {
      if (value.length) pairs.push(`aliases=${value.map(encodeMetadataValue).join(',')}`)
    } else if (typeof value === 'string') pairs.push(`${key}=${encodeMetadataValue(value)}`)
  }
  for (const [key, value] of Object.entries(entry.metadata.unknown)) {
    if (KNOWN_KEYS.has(key) || !/^[a-z_]+$/.test(key) || !value || /\s|-->/.test(value)) throw new Error('Invalid unknown metadata')
    pairs.push(`${key}=${value}`)
  }
  const line = `- ${escapeMemoryText(entry.text)}${pairs.length ? `  <!-- ${pairs.join(' ')} -->` : ''}`
  if (!parseMemoryEntryLine(line)) throw new Error('Invalid memory entry metadata')
  return line
}

export function parseMemoryFile(input: string | Uint8Array): MemoryFileModel {
  let readOnly = false
  let source: string
  if (typeof input === 'string') source = input
  else {
    try { source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(input) }
    catch { source = new TextDecoder('utf-8', { ignoreBOM: true }).decode(input); readOnly = true }
  }
  const hadBom = source.startsWith('\uFEFF')
  if (hadBom) source = source.slice(1)
  const crlf = (source.match(/\r\n/g) ?? []).length
  const lf = (source.match(/(?<!\r)\n/g) ?? []).length
  const lines: MemoryFileLine[] = []
  const chunks = source.match(/[^\n]*\n|[^\n]+$/g) ?? []
  let issues = 0
  for (const chunk of chunks) {
    const eol = chunk.endsWith('\r\n') ? '\r\n' : chunk.endsWith('\n') ? '\n' : ''
    const raw = eol ? chunk.slice(0, -eol.length) : chunk
    if (raw.startsWith('- ')) {
      const entry = parseMemoryEntryLine(raw)
      if (entry) lines.push({ type: 'entry', entry, raw, original: JSON.stringify(entry), eol })
      else { lines.push({ type: 'invalid', raw, eol }); issues++ }
    } else lines.push({ type: 'text', raw, eol })
  }
  const header = /^<!-- nova-memory v(\d+)(?: -->| · generated; edit the topic files instead -->)$/.exec(lines[0]?.raw ?? '')
  const version = header ? Number(header[1]) : null
  return { lines, newline: crlf > lf ? '\r\n' : '\n', readOnly: readOnly || (version !== null && version !== MEMORY_FORMAT_VERSION), issues, version, hadBom }
}

export function serializeMemoryFile(model: MemoryFileModel): string {
  if (model.readOnly) throw new Error('Memory file is read-only')
  const body = model.lines.map(line => {
    const raw = line.type === 'entry' && JSON.stringify(line.entry) !== line.original
      ? serializeMemoryEntryLine(line.entry) : line.raw
    return raw + line.eol
  }).join('')
  return model.version === null ? MEMORY_FILE_HEADER + model.newline + body : body
}
