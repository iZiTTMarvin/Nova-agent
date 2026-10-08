import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MemoryLedger, parseMemoryLedger, reduceMemoryLedger, type MemoryLedgerEvent } from '@runtime/memory/markdown/MemoryLedger'
import { FAKE_MEMORY_SECRETS } from '../../../../fixtures/memory/privacyExamples'

const id = 'm_7f3ak2q9xd'
const otherId = 'm_q2w9e8r7t6'
const created: MemoryLedgerEvent = { v: 1, op: 'create', id, at: 100, conf: 0.8, source: 'workspace', via: 'extract' }

describe('memory provenance ledger', () => {
  it.each(FAKE_MEMORY_SECRETS)('ledger persists redaction instead of the sensitive excerpt %#', secret => {
    ledger.append([{ v: 1, op: 'evidence', id, at: 100, type: 'user_message', excerpt: secret }])
    expect(ledger.read().events).toMatchObject([{ op: 'evidence', excerpt: '[REDACTED]' }])
    expect(readFileSync(ledger.path, 'utf8')).not.toContain('TEST_ONLY_FAKE_BODY')
    expect(readFileSync(ledger.path, 'utf8')).not.toContain(secret)
  })
  it('preserves independent legacy update and last-seen timestamps and rejects invalid seen values', () => {
    const touch: MemoryLedgerEvent = { v: 1, op: 'touch', id, at: 200, seen: 300, conf: .9 }
    expect(reduceMemoryLedger([created, touch], id, 0)).toMatchObject({ updatedAt: 200, lastSeenAt: 300 })
    expect(parseMemoryLedger(JSON.stringify({ ...touch, seen: -1 })).badLines).toBe(1)
    expect(parseMemoryLedger(JSON.stringify({ ...touch, seen: '300' })).badLines).toBe(1)
  })
  let root: string
  let ledger: MemoryLedger
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'nova-ledger-'))
    ledger = new MemoryLedger(join(root, '.ledger.jsonl'), root)
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('reduces timestamps, confidence and distinct evidence sources', () => {
    ledger.append([
      created,
      { v: 1, op: 'evidence', id, at: 110, type: 'workspace', session: 's1', project: 'p1', excerpt: 'source' },
      { v: 1, op: 'evidence', id, at: 120, type: 'workspace', session: 's1', project: 'p2' },
      { v: 1, op: 'evidence', id, at: 130, type: 'tool_result', session: 's2', project: 'p2' },
      { v: 1, op: 'touch', id, at: 125, conf: 0.95 },
      { ...created, id: otherId, at: 200 }
    ])
    expect(reduceMemoryLedger(ledger.read().events, id, 999)).toEqual({
      createdAt: 100, updatedAt: 125, lastSeenAt: 130, confidence: 0.95,
      sourceType: 'workspace', via: 'extract', evidenceCount: 3,
      distinctSessionCount: 2, distinctProjectCount: 2
    })
  })

  it('uses file defaults for user-added entries without provenance', () => {
    expect(reduceMemoryLedger([], id, 123)).toEqual({
      createdAt: 123, updatedAt: 123, lastSeenAt: 123, confidence: 1,
      sourceType: 'user_message', via: 'user-edit', evidenceCount: 0,
      distinctSessionCount: 0, distinctProjectCount: 0
    })
    expect(ledger.read().badLines).toBe(0)
  })

  it('skips malformed events while counting and preserving bad lines during purges', () => {
    const source = [JSON.stringify(created), '{broken', JSON.stringify({ v: 2, id: otherId }), JSON.stringify({ ...created, id: otherId })].join('\n')
    writeFileSync(ledger.path, source)
    expect(ledger.read().badLines).toBe(2)
    expect(ledger.read().events).toHaveLength(2)
    ledger.removeIds(new Set([id]))
    expect(readFileSync(ledger.path, 'utf8')).toBe(['{broken', JSON.stringify({ v: 2, id: otherId }), JSON.stringify({ ...created, id: otherId }), ''].join('\n'))
    expect(ledger.read().events.map(event => event.id)).toEqual([otherId])
  })

  it('separates an unterminated final line before appending', () => {
    writeFileSync(ledger.path, JSON.stringify(created))
    ledger.append([{ v: 1, op: 'touch', id, at: 150, conf: 1 }])
    expect(ledger.read().badLines).toBe(0)
    expect(ledger.read().events).toHaveLength(2)
    expect(readFileSync(ledger.path, 'utf8').endsWith('\n')).toBe(true)
  })

  it('redacts evidence before truncation without persisting the secret', () => {
    const secret = 'sk-' + 'A'.repeat(32)
    ledger.append([{ v: 1, op: 'evidence', id, at: 100, type: 'user_message', excerpt: `source ${secret} ${'x'.repeat(300)}` }])
    const text = readFileSync(ledger.path, 'utf8')
    expect(text).not.toContain(secret)
    const event = ledger.read().events[0]
    if (event.op !== 'evidence') throw new Error('wrong event')
    expect(event.excerpt).toContain('[REDACTED]')
    expect(event.excerpt).toHaveLength(240)
  })

  it.each([
    { ...created, conf: 2 }, { ...created, at: -1 }, { ...created, id: 'bad' },
    { ...created, via: 'unknown' }, { ...created, source: '' },
    { v: 1, op: 'evidence', id, at: 100, type: 'assistant' },
    { v: 1, op: 'evidence', id, at: 100, type: 'workspace', session: 1 }
  ])('rejects invalid ledger input: %o', invalid => {
    expect(parseMemoryLedger(JSON.stringify(invalid)).badLines).toBe(1)
  })

  it('clears all matching provenance and leaves a valid empty ledger', () => {
    ledger.append([created, { v: 1, op: 'touch', id, at: 150, conf: 1 }])
    ledger.removeIds(new Set([id]))
    expect(readFileSync(ledger.path, 'utf8')).toBe('')
    expect(ledger.read()).toEqual({ events: [], lines: [], badLines: 0 })
  })

  it('purges identifiable provenance even if its event is corrupted or has an unknown version', () => {
    writeFileSync(ledger.path, [
      JSON.stringify({ v: 2, id, excerpt: 'forgotten text' }),
      `{"id":"${id}","excerpt":"forgotten text",broken`,
      JSON.stringify({ ...created, id: otherId })
    ].join('\n'))
    expect(ledger.read().badLines).toBe(2)
    ledger.removeIds(new Set([id]))
    expect(readFileSync(ledger.path, 'utf8')).not.toContain('forgotten text')
    expect(ledger.read().events.map(event => event.id)).toEqual([otherId])
  })
})
