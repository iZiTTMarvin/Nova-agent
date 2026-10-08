import { appendFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { MEMORY_EVIDENCE_EXCERPT_MAX_CHARS } from '../memoryConfig'
import { filterPrivacyText } from '../PrivacyFilter'
import { MEMORY_EVIDENCE_TYPES, type MemoryEvidenceType, type MemoryRecord } from '../types'
import { assertMemoryFilePath, memoryFileFingerprint, writeFileAtomic } from './atomicFile'

export type MemoryEntryVia = 'tool' | 'extract' | 'user-edit' | 'migration'
export type MemoryLedgerAppendFile = typeof appendFileSync
export type MemoryLedgerEvent =
  | { v: 1; op: 'create'; id: string; at: number; conf: number; source: string; via: MemoryEntryVia }
  | { v: 1; op: 'touch'; id: string; at: number; conf: number; seen?: number }
  | { v: 1; op: 'evidence'; id: string; at: number; type: MemoryEvidenceType; session?: string; message?: string; project?: string; excerpt?: string }

export interface MemoryLedgerReadResult {
  events: MemoryLedgerEvent[]
  badLines: number
  lines: Array<{ raw: string; event: MemoryLedgerEvent | null; id: string | null }>
}

export type MemoryLedgerFields = Pick<MemoryRecord,
  'createdAt' | 'updatedAt' | 'lastSeenAt' | 'confidence' | 'sourceType' |
  'evidenceCount' | 'distinctSessionCount' | 'distinctProjectCount'> & { via: MemoryEntryVia }

export function parseMemoryLedgerEvent(raw: string): MemoryLedgerEvent | null {
  let value: unknown
  try { value = JSON.parse(raw) } catch { return null }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  if (row.v !== 1 || typeof row.id !== 'string' || !/^m_[a-z0-9]{10}$/.test(row.id) || typeof row.at !== 'number' || !Number.isFinite(row.at) || row.at < 0) return null
  const base = { v: 1 as const, id: row.id, at: row.at }
  if (row.op === 'create' || row.op === 'touch') {
    if (typeof row.conf !== 'number' || !Number.isFinite(row.conf) || row.conf < 0 || row.conf > 1) return null
    if (row.op === 'touch') {
      if (row.seen !== undefined && (typeof row.seen !== 'number' || !Number.isFinite(row.seen) || row.seen < 0)) return null
      return { ...base, op: 'touch', conf: row.conf, ...(row.seen === undefined ? {} : { seen: row.seen as number }) }
    }
    if (typeof row.source !== 'string' || !row.source || !['tool', 'extract', 'user-edit', 'migration'].includes(String(row.via))) return null
    return { ...base, op: 'create', conf: row.conf, source: row.source, via: row.via as MemoryEntryVia }
  }
  if (row.op !== 'evidence' || !MEMORY_EVIDENCE_TYPES.some(type => type === row.type)) return null
  for (const key of ['session', 'message', 'project', 'excerpt']) {
    if (row[key] !== undefined && typeof row[key] !== 'string') return null
  }
  return {
    ...base, op: 'evidence', type: row.type as MemoryEvidenceType,
    session: row.session as string | undefined, message: row.message as string | undefined,
    project: row.project as string | undefined, excerpt: row.excerpt as string | undefined
  }
}

export function parseMemoryLedger(text: string): MemoryLedgerReadResult {
  const lines = text.split('\n').filter((raw, index, all) => !(index === all.length - 1 && raw === ''))
    .map(raw => {
      const event = parseMemoryLedgerEvent(raw)
      const id = event?.id ?? /"id"\s*:\s*"(m_[a-z0-9]{10})"/.exec(raw)?.[1] ?? null
      return { raw, event, id }
    })
  return {
    lines, badLines: lines.filter(line => line.event === null).length,
    events: lines.flatMap(line => line.event ? [line.event] : [])
  }
}

export function reduceMemoryLedger(events: readonly MemoryLedgerEvent[], id: string, fileMtime: number): MemoryLedgerFields {
  const relevant = events.filter(event => event.id === id)
  const created = relevant.find(event => event.op === 'create')
  let confidence = created?.op === 'create' ? created.conf : 1
  const createdAt = created?.at ?? fileMtime
  let updatedAt = createdAt
  let lastSeenAt = createdAt
  const sessions = new Set<string>()
  const projects = new Set<string>()
  let evidenceCount = 0
  for (const event of relevant) {
    lastSeenAt = Math.max(lastSeenAt, event.op === 'touch' ? event.seen ?? event.at : event.at)
    if (event.op === 'touch') { confidence = event.conf; updatedAt = Math.max(updatedAt, event.at) }
    if (event.op === 'evidence') {
      evidenceCount++
      if (event.session) sessions.add(event.session)
      if (event.project) projects.add(event.project)
    }
  }
  return {
    createdAt, updatedAt, lastSeenAt, confidence,
    sourceType: created?.op === 'create' ? created.source : 'user_message',
    via: created?.op === 'create' ? created.via : 'user-edit',
    evidenceCount, distinctSessionCount: sessions.size, distinctProjectCount: projects.size
  }
}

export class MemoryLedger {
  constructor(readonly path: string, private readonly memoryRoot: string, private readonly appendFile: MemoryLedgerAppendFile = appendFileSync) {}

  read(): MemoryLedgerReadResult {
    assertMemoryFilePath(this.path, this.memoryRoot)
    return parseMemoryLedger(existsSync(this.path) ? readFileSync(this.path, 'utf8') : '')
  }

  append(events: readonly MemoryLedgerEvent[]): void {
    if (!events.length) return
    const lines = events.map(event => {
      if (!parseMemoryLedgerEvent(JSON.stringify(event))) throw new Error('Invalid memory ledger event')
      if (event.op !== 'evidence' || event.excerpt === undefined) return JSON.stringify(event)
      const filtered = filterPrivacyText(event.excerpt, { maxOutputChars: Number.MAX_SAFE_INTEGER })
      return JSON.stringify({ ...event, excerpt: filtered.shouldDiscard ? '' : filtered.text.slice(0, MEMORY_EVIDENCE_EXCERPT_MAX_CHARS) })
    })
    assertMemoryFilePath(this.path, this.memoryRoot)
    mkdirSync(dirname(this.path), { recursive: true })
    assertMemoryFilePath(this.path, this.memoryRoot)
    const existing = existsSync(this.path) ? readFileSync(this.path, 'utf8') : ''
    this.appendFile(this.path, (existing && !existing.endsWith('\n') ? '\n' : '') + lines.join('\n') + '\n', { encoding: 'utf8', mode: 0o600 })
  }

  removeIds(ids: ReadonlySet<string>): void {
    const result = this.read()
    const retained = result.lines.filter(line => line.id === null || !ids.has(line.id))
    if (retained.length === result.lines.length) return
    writeFileAtomic(this.path, retained.length ? retained.map(line => line.raw).join('\n') + '\n' : '', {
      memoryRoot: this.memoryRoot, expectedFingerprint: memoryFileFingerprint(this.path)
    })
  }
}
