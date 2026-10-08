import { it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openBetterSqliteMemoryDb } from '@runtime/memory/BetterSqliteMemoryDb'
import { createMarkdownMemoryFixture } from '../../fixtures/memory/MarkdownMemoryFixture'
import { SessionStore } from '@runtime/sessions/SessionStore'
import { resetSessionIndexHostForTests } from '@runtime/sessions/SessionIndexHost'
import { renderMemorySnapshot } from '@runtime/memory/snapshot/renderMemorySnapshot'
import { prepareSessionMemorySnapshot } from '../../../src/main/services/SessionMemorySnapshot'
import { getSessionMemorySnapshotText } from '@runtime/sessions/memorySnapshot'
import { SystemPromptBuilder } from '@runtime/agent/promptBuilder/SystemPromptBuilder'
import { restoreFromLedger } from '@runtime/sessions/contextSnapshot'
import { makeCompactionLedger } from '../../../src/test-support/builders/compactionLedger'

it('real session persistence retains the first snapshot through file edits, reload, ledger restore and opt-out', () => {
  const root = mkdtempSync(join(tmpdir(), 'nova-memory-session-'))
  const memoryRoot = join(root, 'memory')
  mkdirSync(memoryRoot)
  const db = openBetterSqliteMemoryDb(join(memoryRoot, 'memory.db'))
  const now = new Date(2026, 9, 8, 12).getTime()
  try {
    const fixture = createMarkdownMemoryFixture(memoryRoot, db, () => now)
    const sessions = new SessionStore(root)
    const session = sessions.create(join(root, 'workspace'))
    const project = { scopeKind: 'project' as const, scopeId: fixture.store.registerWorkspace(session.workspaceRoot) }
    fixture.store.insert({ id: 'm_0000000001', scope: project, kind: 'convention', memoryKey: 'release', content: 'Original release convention',
      status: 'active', confidence: 1, explicitness: 'user_explicit', sourceType: 'user_message' })
    let reads = 0
    const capture = () => { reads++; return renderMemorySnapshot({ capturedAt: now, project: fixture.store.snapshotScope(project) }) }
    session.memorySnapshot = prepareSessionMemorySnapshot(session, true, now, capture)
    session.frozenSystemPrompt = SystemPromptBuilder.build({ agentRole: 'Nova', memorySnapshot: getSessionMemorySnapshotText(session, true) })
    sessions.save(session)
    sessions.appendMessage(session.id, { id: 'user-1', role: 'user', content: 'first', timestamp: now })
    sessions.appendMessage(session.id, { id: 'assistant-1', role: 'assistant', content: 'answer', timestamp: now + 1 })
    const expected = JSON.stringify(session.memorySnapshot)
    fixture.store.purge(project, 'm_0000000001')
    writeFileSync(join(root, 'unrelated.txt'), 'unrelated data')
    const restarted = new SessionStore(root)
    const restored = restarted.load(session.id)
    if (!restored) throw new Error('Session did not reload')
    expect(JSON.stringify(restored.memorySnapshot)).toBe(expected)
    expect(prepareSessionMemorySnapshot(restored, true, now + 2, capture)).toEqual(session.memorySnapshot)
    expect(reads).toBe(1)
    const ledger = makeCompactionLedger({ summary: 'Saved handoff',
      shadows: { from: { messageId: 'user-1', step: 0 }, to: { messageId: 'assistant-1', step: 0 } }, tailFrom: null })
    restarted.saveContextSnapshot(session.id, ledger)
    const loadedLedger = restarted.loadContextSnapshot(session.id)
    if (!loadedLedger) throw new Error('Ledger did not reload')
    const result = restoreFromLedger(restored, loadedLedger, restored.frozenSystemPrompt!)
    expect(result.kind).not.toBe('invalid')
    const system = result.messages[0].content
    expect(typeof system === 'string' && system.startsWith(restored.frozenSystemPrompt!)).toBe(true)
    expect(system).toContain('Original release convention')
    expect(system).toContain('Saved handoff')
    restored.memoryOptOut = true
    restarted.save(restored)
    const excluded = restarted.load(session.id)
    if (!excluded) throw new Error('Opt-out session did not reload')
    expect(getSessionMemorySnapshotText(excluded, true)).toBeUndefined()
    excluded.memoryOptOut = false
    expect(getSessionMemorySnapshotText(excluded, true)).toBe(session.memorySnapshot.text)
    expect(JSON.stringify(excluded.memorySnapshot)).toBe(expected)
  } finally { db.close(); resetSessionIndexHostForTests(); rmSync(root, { recursive: true, force: true }) }
})

it('privacy choice has one owner through stale turn saves, drafts, reload and summary projection without rewriting messages', () => {
  const root = mkdtempSync(join(tmpdir(), 'nova-memory-opt-out-'))
  try {
    const store = new SessionStore(root)
    const session = store.create(join(root, 'workspace'))
    session.memorySnapshot = { formatVersion: 1, capturedAt: 1, text: 'Private snapshot body', reason: 'captured', globalCoreCount: 1, projectCoreCount: 2, omittedCoreCount: 0 }
    store.save(session)
    store.appendMessage(session.id, { id: 'u1', parentId: null, role: 'user', content: 'preserve history', timestamp: 1 })
    store.save(store.load(session.id)!)
    const before = readFileSync(join(root, 'sessions', session.id, 'messages.jsonl'))
    const staleTurn = store.load(session.id)!
    store.updateMemoryOptOut(session.id, true)
    expect(readFileSync(join(root, 'sessions', session.id, 'messages.jsonl'))).toEqual(before)
    store.save(staleTurn)
    const reopened = new SessionStore(root)
    expect(reopened.load(session.id)?.memoryOptOut).toBe(true)
    expect(getSessionMemorySnapshotText(reopened.load(session.id)!, true)).toBeUndefined()
    expect(reopened.list()[0].memorySnapshot).toEqual({ capturedAt: 1, globalCoreCount: 1, projectCoreCount: 2, omittedCoreCount: 0 })
    expect(JSON.stringify(reopened.list())).not.toContain('Private snapshot body')
    const oldPrivateTurn = reopened.load(session.id)!
    reopened.updateMemoryOptOut(session.id, false)
    expect(readFileSync(join(root, 'sessions', session.id, 'messages.jsonl'))).toEqual(before)
    reopened.save(oldPrivateTurn)
    expect(reopened.load(session.id)?.memoryOptOut).toBe(false)
    expect(readFileSync(join(root, 'sessions', session.id, 'messages.jsonl'))).toEqual(before)
    const draft = store.create(join(root, 'workspace'), 'default', { deferPersistence: true })
    store.updateMemoryOptOut(draft.id, true)
    store.save(draft)
    expect(store.load(draft.id)?.memoryOptOut).toBe(true)
    store.appendMessage(draft.id, { id: 'd1', role: 'user', content: 'first private turn', timestamp: 2 })
    expect(new SessionStore(root).load(draft.id)?.memoryOptOut).toBe(true)
  } finally { resetSessionIndexHostForTests(); rmSync(root, { recursive: true, force: true }) }
})
