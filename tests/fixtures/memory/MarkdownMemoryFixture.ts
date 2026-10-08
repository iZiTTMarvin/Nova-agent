import type { MemoryDb } from '../../../src/runtime/memory/MemoryDb'
import { MemoryEntryStore, type MemoryEntryStoreOptions } from '../../../src/runtime/memory/markdown/MemoryEntryStore'
import { MemoryIndex } from '../../../src/runtime/memory/index/MemoryIndex'
import { MarkdownMemoryRepository } from '../../../src/runtime/memory/repository/MarkdownMemoryRepository'
import type { MemoryRecordDraft } from '../../../src/runtime/memory/repository/MemoryRepository'
import { MEMORY_FILE_HEADER, MEMORY_TOPIC_FILES, localMemoryDate, serializeMemoryEntryLine, type MemoryEntryBy } from '../../../src/runtime/memory/markdown/entryFormat'
import { getProjectMemoryDir } from '../../../src/runtime/memory/MemoryPaths'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { MemoryLedgerEvent } from '../../../src/runtime/memory/markdown/MemoryLedger'

export function createMarkdownMemoryFixture(root: string, db: MemoryDb | null, now: () => number = Date.now, options: Pick<MemoryEntryStoreOptions, 'appendLedgerFile' | 'writeFile'> = {}) {
  const index = db ? new MemoryIndex(db, now) : null
  const store = new MemoryEntryStore(root, {
    ...options,
    now,
    onIndexChanged: (scope, entries) => index?.rebuild(scope, entries),
    readPreviousEntries: scope => index?.readPreviousEntries(scope) ?? []
  })
  return { store, index, repository: new MarkdownMemoryRepository(store, index, () => {}, (scope, id) => store.purge(scope, id)) }
}

export function seedMarkdownMemoryFiles(root: string, drafts: readonly MemoryRecordDraft[], now: number): void {
  const files = new Map<string, string[]>()
  const ledgers = new Map<string, MemoryLedgerEvent[]>()
  const by: Record<MemoryRecordDraft['explicitness'], MemoryEntryBy> = { user_explicit: 'user', workspace_verified: 'verified', observed: 'observed', inferred: 'inferred' }
  const replacements = new Map(drafts.flatMap(draft => draft.supersedesId ? [[draft.supersedesId, draft.id] as const] : []))
  for (const draft of drafts) {
    const dir = getProjectMemoryDir(root, draft.scope.scopeId)
    const archived = draft.status === 'superseded' || draft.status === 'retracted'
    const file = join(dir, archived ? 'archive.md' : draft.status === 'pending' ? 'inbox.md' : MEMORY_TOPIC_FILES[draft.kind])
    const lines = files.get(file) ?? [MEMORY_FILE_HEADER, '']
    lines.push(serializeMemoryEntryLine({ text: draft.content, metadata: {
      id: draft.id, by: by[draft.explicitness], added: localMemoryDate(now), key: draft.memoryKey ?? undefined, unknown: {},
      aliases: draft.aliases ? [...draft.aliases] : undefined,
      src: draft.sourcePath ?? undefined, fp: draft.sourceFingerprint ?? undefined,
      kind: archived || draft.status === 'pending' ? draft.kind : undefined,
      status: archived ? draft.status as 'superseded' | 'retracted' : undefined,
      until: archived ? localMemoryDate(draft.validTo ?? now) : undefined,
      by_id: replacements.get(draft.id), verify: draft.status === 'needs_verification' ? '1' : undefined
    } }))
    files.set(file, lines)
    const events = ledgers.get(dir) ?? []
    events.push({ v: 1, op: 'create', id: draft.id, at: draft.validFrom ?? now, conf: draft.confidence, source: draft.sourceType, via: draft.via ?? 'tool' })
    for (const evidence of draft.evidence ?? []) events.push({ v: 1, op: 'evidence', id: draft.id, at: evidence.createdAt ?? now, type: evidence.evidenceType, session: evidence.sessionId ?? undefined, message: evidence.messageId ?? undefined, project: evidence.projectScopeId ?? undefined, excerpt: evidence.excerpt ?? undefined })
    ledgers.set(dir, events)
  }
  for (const [path, lines] of files) { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, lines.join('\n') + '\n') }
  for (const [dir, events] of ledgers) writeFileSync(join(dir, '.ledger.jsonl'), events.map(event => JSON.stringify(event)).join('\n') + '\n')
}
