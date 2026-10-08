import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, statSync, rmdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import type { MemoryDb } from '../MemoryDb'
import { computeLegacyWorkspaceHashes, GLOBAL_SCOPE_ID, getProjectMemoryDir } from '../MemoryPaths'
import { hasLegacyMemoryRecords, readMemorySchemaVersion } from '../schema/MemoryMigrations'
import type { ForgottenMemory, MemoryKind, MemoryRecord, MemoryScope, MemoryStatus } from '../types'
import { MemoryEntryStore } from '../markdown/MemoryEntryStore'
import { localMemoryDate, MEMORY_FILE_HEADER, MEMORY_TOPIC_FILES, parseMemoryFile, serializeMemoryEntryLine, type MemoryFileEntry } from '../markdown/entryFormat'
import { parseMemoryLedger, reduceMemoryLedger, type MemoryLedgerEvent } from '../markdown/MemoryLedger'
import { assertMemoryFilePath, memoryFileFingerprint, writeFileAtomic } from '../markdown/atomicFile'
import { decideMemoryPolicy } from '../policy/MemoryPolicy'
import { filterPrivacyText } from '../PrivacyFilter'
import { parseMemoryEvidenceRow, parseMemoryRecordRow } from './legacyRows'

interface ExportedEntry { entry: MemoryFileEntry; kind: MemoryKind; status: MemoryStatus; events: MemoryLedgerEvent[] }
interface WrittenFile { path: string; original: Buffer | null; fingerprint: string | null }
const BY = { user_explicit: 'user', workspace_verified: 'verified', observed: 'observed', inferred: 'inferred' } as const
const EXPLICIT = { user: 'user_explicit', verified: 'workspace_verified', observed: 'observed', inferred: 'inferred' } as const
const RECORD_COLUMNS = ['id', 'scope_kind', 'scope_id', 'kind', 'memory_key', 'content', 'status', 'confidence', 'explicitness', 'source_type', 'valid_from', 'valid_to', 'supersedes_id', 'evidence_count', 'distinct_session_count', 'distinct_project_count', 'source_path', 'source_fingerprint', 'created_at', 'updated_at', 'last_seen_at', 'metadata_json']
const EVIDENCE_COLUMNS = ['id', 'memory_id', 'session_id', 'message_id', 'project_scope_id', 'evidence_type', 'excerpt', 'created_at']
const aliases = (columns: readonly string[]): string => columns.map(column => `${column} AS ${column.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())}`).join(', ')

/** 迁移后短 ID 的唯一公式，导出与备份回改必须走同一处，否则两边对不上。 */
const legacyMigratedId = (scopeKind: string, scopeId: string, id: string): string =>
  `m_${createHash('sha256').update(`${scopeKind}:${scopeId}:${id}`).digest('hex').slice(0, 10)}`

// Remove alongside legacy upgrade support in the first release that excludes pre-Markdown versions.
export class LegacyMemoryMigrator {
  constructor(readonly memoryRoot: string, private readonly now: () => number = Date.now) {}

  isMigrationComplete(): boolean { return this.marker() }

  listUnclaimed(): { oldHash: string; fileCount: number; diskBytes: number }[] {
    const root = join(this.memoryRoot, 'projects', '_legacy')
    assertMemoryFilePath(join(root, 'probe.md'), this.memoryRoot)
    if (!existsSync(root)) return []
    return readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && /^[0-9a-f]{16}$/.test(entry.name)).flatMap(entry => {
      const dir = join(root, entry.name)
      assertMemoryFilePath(join(dir, 'probe.md'), this.memoryRoot)
      const files = this.files(dir)
      return files.length ? [{ oldHash: entry.name, fileCount: files.length, diskBytes: files.reduce((sum, path) => sum + statSync(path).size, 0) }] : []
    })
  }

  deleteUnclaimed(oldHash: string): void {
    if (!/^[0-9a-f]{16}$/.test(oldHash)) throw new Error('Invalid legacy hash')
    const dir = join(this.memoryRoot, 'projects', '_legacy', oldHash)
    assertMemoryFilePath(join(dir, 'probe.md'), this.memoryRoot)
    if (!existsSync(dir)) return
    const files = this.files(dir)
    for (const path of files) { assertMemoryFilePath(path, this.memoryRoot); unlinkSync(path) }
    const removeEmpty = (path: string): void => {
      assertMemoryFilePath(join(path, 'probe.md'), this.memoryRoot)
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Legacy directory changed during deletion')
        removeEmpty(join(path, entry.name))
      }
      rmdirSync(path)
    }
    removeEmpty(dir)
  }

  upgradeLearnedEpoch(store: MemoryEntryStore, epoch: number): number {
    if (!Number.isSafeInteger(epoch) || epoch < 1) throw new Error('Invalid learned memory epoch')
    const path = join(this.memoryRoot, '.migration.json')
    assertMemoryFilePath(path, this.memoryRoot)
    if (!existsSync(path)) return 0
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !('version' in raw) || raw.version !== 1 || !('markdownMigrated' in raw) || raw.markdownMigrated !== true || !('learnedEpoch' in raw) || typeof raw.learnedEpoch !== 'number' || !Number.isSafeInteger(raw.learnedEpoch) || raw.learnedEpoch < 1) throw new Error('Invalid learned memory marker')
    if (epoch <= raw.learnedEpoch) return 0
    if (store.isReadOnly()) throw new Error('Memory files are read-only')
    const fingerprint = memoryFileFingerprint(path)
    let removed = 0
    for (const scope of store.listScopes()) removed += store.maintain(scope, true)
    writeFileAtomic(path, JSON.stringify({ ...raw, learnedEpoch: epoch }) + '\n', { memoryRoot: this.memoryRoot, expectedFingerprint: fingerprint })
    return removed
  }

  private marker(): boolean {
    const path = join(this.memoryRoot, '.migration.json')
    assertMemoryFilePath(path, this.memoryRoot)
    if (!existsSync(path)) return false
    const data: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof data !== 'object' || data === null || !('markdownMigrated' in data) || !('version' in data) || data.version !== 1) throw new Error('Invalid memory migration marker')
    return data.markdownMigrated === true
  }

  backup(): void {
    if (this.marker()) return
    for (const suffix of ['', '-wal', '-shm']) {
      const source = join(this.memoryRoot, `memory.db${suffix}`)
      const target = join(this.memoryRoot, `memory.db.pre-markdown.bak${suffix}`)
      assertMemoryFilePath(source, this.memoryRoot); assertMemoryFilePath(target, this.memoryRoot)
      if (existsSync(source) && !existsSync(target)) copyFileSync(source, target)
    }
    for (const directory of this.oldDirectories()) {
      const target = join(this.memoryRoot, '.backups', 'pre-markdown', directory)
      for (const source of this.files(join(this.memoryRoot, directory))) {
        const destination = join(target, relative(join(this.memoryRoot, directory), source))
        assertMemoryFilePath(destination, this.memoryRoot)
        if (!existsSync(destination)) { mkdirSync(dirname(destination), { recursive: true }); copyFileSync(source, destination) }
      }
    }
  }

  migrate(db: MemoryDb): { exported: number; skipped: boolean } {
    if (readMemorySchemaVersion(db) > 3) throw new Error('Unsupported memory database version')
    if (this.marker()) {
      if (hasLegacyMemoryRecords(db)) this.finishSql(db)
      return { exported: 0, skipped: true }
    }
    this.backup()
    const legacy = hasLegacyMemoryRecords(db)
    const records = legacy ? db.prepare(`SELECT ${aliases(RECORD_COLUMNS)} FROM memory_records ORDER BY rowid`).all<unknown>().map(parseMemoryRecordRow) : []
    const evidence = legacy ? db.prepare(`SELECT ${aliases(EVIDENCE_COLUMNS)} FROM memory_evidence ORDER BY rowid`).all<unknown>().map(parseMemoryEvidenceRow) : []
    const live = records.filter(record => record.status !== 'retracted')
    if (live.some(record => record.scopeKind === 'global' && record.kind === 'project_fact')) {
      throw new Error('Legacy global memory cannot contain project facts')
    }
    const ids = new Map(live.map(record => [record.id, legacyMigratedId(record.scopeKind, record.scopeId, record.id)]))
    if (new Set(ids.values()).size !== ids.size) throw new Error('Legacy memory ID collision')
    const replacement = new Map(live.filter(record => record.supersedesId).map(record => [record.supersedesId!, ids.get(record.id)!]))
    const grouped = new Map<string, ExportedEntry[]>()
    for (const record of live) {
      if (record.scopeKind === 'project' && !/^[0-9a-f]{16}$/.test(record.scopeId)) throw new Error('Invalid legacy project scope')
      const dir = record.scopeKind === 'global' ? join(this.memoryRoot, 'global') : join(this.memoryRoot, 'projects', '_legacy', record.scopeId)
      const id = ids.get(record.id)!
      const kind = record.kind
      const entry: MemoryFileEntry = { text: record.content, metadata: {
        id, by: BY[record.explicitness], added: localMemoryDate(record.createdAt), seen: localMemoryDate(record.lastSeenAt),
        key: record.memoryKey ?? undefined, src: record.sourcePath ?? undefined, fp: record.sourceFingerprint ?? undefined,
        verify: record.status === 'needs_verification' ? '1' : undefined,
        kind: record.status === 'pending' || record.status === 'superseded' ? kind : undefined,
        status: record.status === 'superseded' ? 'superseded' : undefined,
        until: record.status === 'superseded' ? localMemoryDate(record.validTo ?? record.updatedAt) : undefined,
        by_id: replacement.get(record.id), unknown: {}
      } }
      const events: MemoryLedgerEvent[] = [
        { v: 1, op: 'create', id, at: record.createdAt, conf: record.confidence, source: record.sourceType, via: 'migration' },
        { v: 1, op: 'touch', id, at: record.updatedAt, seen: record.lastSeenAt, conf: record.confidence },
        ...evidence.filter(item => item.memoryId === record.id).map(item => ({
          v: 1 as const, op: 'evidence' as const, id, at: item.createdAt, type: item.evidenceType,
          session: item.sessionId ?? undefined, message: item.messageId ?? undefined, project: item.projectScopeId ?? undefined,
          excerpt: item.excerpt === null ? undefined : filterPrivacyText(item.excerpt).text.slice(0, 240)
        }))
      ]
      const entries = grouped.get(dir) ?? []
      entries.push({ entry, kind, status: record.status, events }); grouped.set(dir, entries)
    }
    const written = new Map<string, WrittenFile>()
    const write = (path: string, content: string | Uint8Array): void => {
      assertMemoryFilePath(path, this.memoryRoot)
      const previous = written.get(path)
      const fingerprint = memoryFileFingerprint(path)
      if (previous && fingerprint !== previous.fingerprint) throw new Error('Legacy export changed externally; write refused')
      const original = previous ? previous.original : existsSync(path) ? readFileSync(path) : null
      writeFileAtomic(path, content, { memoryRoot: this.memoryRoot, expectedFingerprint: memoryFileFingerprint(path) })
      written.set(path, { path, original, fingerprint: memoryFileFingerprint(path) })
    }
    let transaction = false
    try {
      for (const [dir, entries] of grouped) {
        for (const relPath of new Set(entries.map(item => this.entryPath(item)))) {
          const path = join(dir, relPath)
          const original = existsSync(path) ? readFileSync(path, 'utf8') : `${MEMORY_FILE_HEADER}\n`
          const model = parseMemoryFile(original)
          if (model.readOnly || model.issues) throw new Error('Legacy export destination requires repair')
          const existing = new Map(model.lines.flatMap(line => line.type === 'entry' ? [[line.entry.metadata.id, line.entry.text] as const] : []))
          const missing = entries.filter(item => this.entryPath(item) === relPath && !existing.has(item.entry.metadata.id))
          for (const item of entries.filter(item => this.entryPath(item) === relPath)) if (existing.has(item.entry.metadata.id) && existing.get(item.entry.metadata.id) !== item.entry.text) throw new Error('Legacy export ID conflicts with destination')
          if (missing.length) write(path, original.replace(/\n?$/, '\n') + missing.map(item => serializeMemoryEntryLine(item.entry)).join('\n') + '\n')
        }
        const path = join(dir, '.ledger.jsonl')
        const original = existsSync(path) ? readFileSync(path, 'utf8') : ''
        const parsed = parseMemoryLedger(original)
        if (parsed.badLines) throw new Error('Legacy export ledger requires repair')
        const previous = new Set(parsed.events.map(event => JSON.stringify(event)))
        const events = entries.flatMap(item => item.events).filter(event => !previous.has(JSON.stringify(event)))
        if (events.length) write(path, original.replace(/\n?$/, original ? '\n' : '') + events.map(event => JSON.stringify(event)).join('\n') + '\n')
      }
      for (const directory of this.oldDirectories()) {
        const sourceDir = join(this.memoryRoot, directory)
        const destinationDir = directory === GLOBAL_SCOPE_ID ? join(this.memoryRoot, 'global') : join(this.memoryRoot, 'projects', '_legacy', directory)
        for (const source of this.files(sourceDir).filter(path => path.endsWith('.md'))) {
          const oldRel = relative(sourceDir, source).replace(/\\/g, '/')
          const relPath = oldRel === 'MEMORY.md' ? 'notes.md' : oldRel === 'episodic/summary.md' ? 'episodic/legacy.md' : Object.values(MEMORY_TOPIC_FILES).includes(oldRel) || oldRel === 'inbox.md' || oldRel === 'archive.md' ? `documents/legacy/${oldRel}` : oldRel
          const destination = join(destinationDir, relPath)
          const content = readFileSync(source)
          if (existsSync(destination)) {
            const previous = readFileSync(destination)
            if (!previous.includes(content)) write(destination, Buffer.concat([previous, Buffer.from('\n\n## Imported legacy notes\n\n'), content]))
          } else write(destination, content)
        }
      }
      this.validateExport(grouped, live)
      db.exec('BEGIN IMMEDIATE'); transaction = true
      this.dropLegacy(db)
      write(join(this.memoryRoot, '.migration.json'), JSON.stringify({ version: 1, markdownMigrated: true, migratedAt: this.now(), learnedEpoch: 1 }) + '\n')
      db.exec('COMMIT'); transaction = false
      this.vacuumLegacyResidue(db)
      return { exported: live.length, skipped: false }
    } catch (error) {
      if (transaction) db.exec('ROLLBACK')
      const failures: unknown[] = []
      for (const item of [...written.values()].reverse()) {
        try {
          if (memoryFileFingerprint(item.path) !== item.fingerprint) throw new Error('Legacy export changed externally; rollback refused')
          if (item.original === null) unlinkSync(item.path)
          else writeFileAtomic(item.path, item.original, { memoryRoot: this.memoryRoot, expectedFingerprint: item.fingerprint })
        } catch (rollbackError) { failures.push(rollbackError) }
      }
      if (failures.length) throw new AggregateError([error, ...failures], 'Legacy memory rollback needs repair')
      throw error
    }
  }

  validateExport(grouped: ReadonlyMap<string, readonly ExportedEntry[]>, source: readonly MemoryRecord[]): void {
    let count = 0
    const statuses = new Map<MemoryStatus, number>()
    for (const [dir, entries] of grouped) {
      const ledger = parseMemoryLedger(readFileSync(join(dir, '.ledger.jsonl'), 'utf8'))
      if (ledger.badLines) throw new Error('Export ledger contains invalid events')
      for (const item of entries) {
        const file = parseMemoryFile(readFileSync(join(dir, this.entryPath(item))))
        const matches = file.lines.filter(line => line.type === 'entry' && line.entry.metadata.id === item.entry.metadata.id)
        if (file.readOnly || matches.length !== 1) throw new Error('Export count mismatch')
        const original = source.find(record => record.id && item.entry.metadata.id === legacyMigratedId(record.scopeKind, record.scopeId, record.id))!
        const reduced = reduceMemoryLedger(ledger.events, item.entry.metadata.id!, 0)
        if (reduced.createdAt !== original.createdAt || reduced.updatedAt !== original.updatedAt || reduced.lastSeenAt !== original.lastSeenAt || reduced.confidence !== original.confidence || reduced.evidenceCount !== item.events.filter(event => event.op === 'evidence').length) throw new Error('Export provenance mismatch')
        count++; statuses.set(item.status, (statuses.get(item.status) ?? 0) + 1)
      }
    }
    if (count !== source.length || source.some(record => statuses.get(record.status) !== source.filter(item => item.status === record.status).length)) throw new Error('Export status count mismatch')
  }

  claim(workspaceRoot: string, store: MemoryEntryStore): number {
    if (!this.marker() || store.isReadOnly()) return 0
    const scope: MemoryScope = { scopeKind: 'project', scopeId: store.registerWorkspace(workspaceRoot) }
    const target = getProjectMemoryDir(this.memoryRoot, scope.scopeId, workspaceRoot)
    let count = 0
    for (const hash of computeLegacyWorkspaceHashes(workspaceRoot)) {
      const dir = join(this.memoryRoot, 'projects', '_legacy', hash)
      if (!existsSync(dir)) continue
      const ledgerPath = join(dir, '.ledger.jsonl')
      const ledger = existsSync(ledgerPath) ? parseMemoryLedger(readFileSync(ledgerPath, 'utf8')) : { events: [], badLines: 0 }
      if (ledger.badLines) throw new Error('Legacy staging ledger requires repair')
      const files = this.files(dir)
      const fingerprints = new Map(files.map(path => [path, memoryFileFingerprint(path)]))
      const imports: Array<{ path: string; entry: MemoryFileEntry; kind: MemoryKind; status: MemoryStatus }> = []
      for (const path of files) {
        const relPath = relative(dir, path).replace(/\\/g, '/')
        const kind = (Object.entries(MEMORY_TOPIC_FILES) as [MemoryKind, string][]).find(([, value]) => value === relPath)?.[0]
        if (!kind && relPath !== 'inbox.md' && relPath !== 'archive.md') continue
        const model = parseMemoryFile(readFileSync(path))
        if (model.readOnly || model.issues) throw new Error('Legacy staging file requires repair')
        for (const line of model.lines) if (line.type === 'entry') {
          const entryKind = kind ?? line.entry.metadata.kind
          if (!entryKind || !line.entry.metadata.id) throw new Error('Invalid staging entry')
          imports.push({ path, entry: line.entry, kind: entryKind, status: relPath === 'inbox.md' ? 'pending' : relPath === 'archive.md' ? line.entry.metadata.status! : line.entry.metadata.verify ? 'needs_verification' : 'active' })
        }
      }
      const mappings = new Map<string, string>()
      for (const item of imports) {
        const id = item.entry.metadata.id!
        const fields = reduceMemoryLedger(ledger.events, id, 0)
        const related = store.list(scope)
        const decision = decideMemoryPolicy({ kind: item.kind, scopeHint: 'project', memoryKey: item.entry.metadata.key ?? null, content: item.entry.text,
          explicitness: EXPLICIT[item.entry.metadata.by!], confidence: fields.confidence, intent: 'assert', evidence: [{ type: 'user_message', excerpt: item.entry.text }] }, {
          now: this.now(), sessionId: 'migration', projectScopeId: scope.scopeId, relatedRecords: related.map(entry => ({ record: entry.record,
            evidenceSessionIds: new Set(store.listEvidence(scope, entry.record.id).flatMap(event => event.sessionId ? [event.sessionId] : [])),
            evidenceProjectScopeIds: new Set(store.listEvidence(scope, entry.record.id).flatMap(event => event.projectScopeId ? [event.projectScopeId] : [])) }))
        })
        const merge = (item.status === 'active' || item.status === 'needs_verification') && decision.operation === 'MERGE' ? related.find(entry => entry.record.id === decision.targetId) : undefined
        mappings.set(id, merge?.record.id ?? id)
        if (merge) {
          const events = ledger.events.filter(event => event.id === id && event.op !== 'create').map(event => ({ ...event, id: merge.record.id,
            ...(event.op === 'touch' && decision.operation === 'MERGE' && id !== merge.record.id ? { conf: Math.max(merge.record.confidence, decision.confidence) } : {}) }))
          store.importEntry(scope, { text: merge.record.content, metadata: { ...item.entry.metadata, id: merge.record.id, by: item.entry.metadata.by, unknown: item.entry.metadata.unknown } }, merge.record.kind, merge.record.status, events)
        } else {
          if (related.some(entry => entry.record.memoryKey && entry.record.memoryKey === item.entry.metadata.key && entry.record.content !== item.entry.text)) console.warn('[memory] legacy claim retained conflicting entries')
          store.importEntry(scope, item.entry, item.kind, item.status, ledger.events.filter(event => event.id === id))
        }
        count++
      }
      if ([...mappings].some(([from, to]) => from !== to)) store.remapReplacementIds(scope, mappings)
      for (const path of files.filter(path => !imports.some(item => item.path === path) && path !== ledgerPath)) {
        const destination = join(target, relative(dir, path))
        assertMemoryFilePath(destination, this.memoryRoot)
        const content = readFileSync(path)
        const previous = existsSync(destination) ? readFileSync(destination) : null
        if (!previous?.includes(content)) writeFileAtomic(destination, previous ? Buffer.concat([previous, Buffer.from('\n\n## Imported legacy notes\n\n'), content]) : content, { memoryRoot: this.memoryRoot, expectedFingerprint: memoryFileFingerprint(destination) })
      }
      // Preserve staging sources until every target write succeeds; replay is idempotent.
      for (const path of files) if (memoryFileFingerprint(path) !== fingerprints.get(path)) throw new Error('Legacy staging changed during claim')
      for (const path of files) { assertMemoryFilePath(path, this.memoryRoot); unlinkSync(path) }
    }
    return count
  }

  private entryPath(item: ExportedEntry): string { return item.status === 'pending' ? 'inbox.md' : item.status === 'superseded' ? 'archive.md' : MEMORY_TOPIC_FILES[item.kind] }
  private oldDirectories(): string[] { return readdirSync(this.memoryRoot, { withFileTypes: true }).filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && (/^[0-9a-f]{16}$/.test(entry.name) || entry.name === GLOBAL_SCOPE_ID)).map(entry => entry.name) }
  private files(dir: string): string[] {
    const files: string[] = []
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isSymbolicLink()) throw new Error('Legacy memory contains a symbolic link')
      if (entry.isDirectory()) files.push(...this.files(path))
      else if (entry.isFile()) { assertMemoryFilePath(path, this.memoryRoot); files.push(path) }
    }
    return files
  }
  private dropLegacy(db: MemoryDb): void {
    for (const trigger of ['memory_records_fts_ai', 'memory_records_fts_ad', 'memory_records_fts_au']) db.exec(`DROP TRIGGER IF EXISTS ${trigger}`)
    for (const table of ['memory_record_fts', 'memory_evidence', 'memory_records']) db.exec(`DROP TABLE IF EXISTS ${table}`)
    db.exec('PRAGMA user_version = 3')
  }
  private finishSql(db: MemoryDb): void {
    db.exec('BEGIN IMMEDIATE')
    try { this.dropLegacy(db); db.exec('COMMIT') } catch (error) { db.exec('ROLLBACK'); throw error }
    this.vacuumLegacyResidue(db)
  }

  /** dropLegacy 释放的旧表页仍留有数据，VACUUM 重建库文件并截断 WAL；失败不判迁移失败。 */
  private vacuumLegacyResidue(db: MemoryDb): void {
    try {
      db.exec('VACUUM')
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    } catch {
      console.warn('[memory] legacy table residue cleanup failed')
    }
  }

  /**
   * 彻底遗忘时同步清理迁移备份：memory.db.pre-markdown.bak 是旧库全量副本，
   * 删除命中行后逐字节核查 bak/-wal/-shm，仍含任一被遗忘正文则 fail closed 抛错（不含正文本身）。
   */
  redactBackups(forgotten: ForgottenMemory, openDb: (path: string) => MemoryDb): void {
    const bakPath = join(this.memoryRoot, 'memory.db.pre-markdown.bak')
    if (!existsSync(bakPath)) return
    assertMemoryFilePath(bakPath, this.memoryRoot)
    const db = openDb(bakPath)
    try {
      db.exec('PRAGMA secure_delete=ON')
      const hasRecords = !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_records'").get()
      if (hasRecords) {
        const contents = new Set(forgotten.contents)
        const targets = db.prepare(`SELECT ${aliases(RECORD_COLUMNS)} FROM memory_records`).all<unknown>()
          .map(parseMemoryRecordRow)
          .filter(record => forgotten.ids.includes(legacyMigratedId(record.scopeKind, record.scopeId, record.id)) || contents.has(record.content))
        // 没有命中行就不动库：每次遗忘都 VACUUM 整个备份没有必要，但仍做字节核查
        if (targets.length) {
          db.exec('BEGIN IMMEDIATE')
          try {
            const removeEvidence = db.prepare('DELETE FROM memory_evidence WHERE memory_id=?')
            const removeRecord = db.prepare('DELETE FROM memory_records WHERE id=?')
            for (const record of targets) { removeEvidence.run(record.id); removeRecord.run(record.id) }
            // 外部内容表只能整体重建，其余表合并段即可丢弃已删条目
            const fts = db.prepare("SELECT sql FROM sqlite_master WHERE name='memory_record_fts'").get<{ sql: string | null }>()
            if (fts?.sql) db.exec(`INSERT INTO memory_record_fts(memory_record_fts) VALUES('${/content\s*=\s*'[^']+'/.test(fts.sql) ? 'rebuild' : 'optimize'}')`)
            db.exec('COMMIT')
          } catch (error) { db.exec('ROLLBACK'); throw error }
          db.exec('VACUUM')
          db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
        }
      }
    } finally { db.close() }
    for (const suffix of ['', '-wal', '-shm']) {
      const path = `${bakPath}${suffix}`
      if (!existsSync(path)) continue
      const bytes = readFileSync(path)
      if (forgotten.contents.some(content => bytes.includes(Buffer.from(content, 'utf8')))) {
        throw new Error('遗忘未完成：迁移备份仍含已遗忘内容')
      }
    }
  }
}
