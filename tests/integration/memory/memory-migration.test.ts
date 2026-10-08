import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { BetterSqliteMemoryDb, openBetterSqliteMemoryDb } from '@runtime/memory/BetterSqliteMemoryDb'
import { initMemorySchema } from '@runtime/memory/MemorySchema'
import { searchIndexed, upsertIndexedFile } from '@runtime/memory/MemoryIndexer'
import { LegacyMemoryMigrator } from '@runtime/memory/migration/LegacyMemoryMigrator'
import { computeLegacyWorkspaceHashes, computeWorkspaceHash, getProjectMemoryDir } from '@runtime/memory/MemoryPaths'
import { MemoryEntryStore } from '@runtime/memory/markdown/MemoryEntryStore'
import { parseMemoryFile } from '@runtime/memory/markdown/entryFormat'
import { parseMemoryLedger, reduceMemoryLedger } from '@runtime/memory/markdown/MemoryLedger'
import { migrateMemorySchema, readMemorySchemaVersion, MemoryMigrationError } from '@runtime/memory/schema/MemoryMigrations'
import type { MemoryDb } from '@runtime/memory/MemoryDb'
import { MemoryService } from '@runtime/memory/MemoryService'

describe('legacy memory migration', () => {
  let root: string
  let db: BetterSqliteMemoryDb | undefined
  afterEach(() => { db?.close(); db = undefined; if (root) rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks() })
  function open(): BetterSqliteMemoryDb {
    root = mkdtempSync(join(tmpdir(), 'nova-memory-migration-'))
    db = new BetterSqliteMemoryDb(join(root, 'memory.db'))
    return db
  }
  function legacy(): BetterSqliteMemoryDb {
    const target = open()
    target.exec(readFileSync(join(process.cwd(), 'tests/fixtures/memory/legacy-v2.sql'), 'utf8'))
    return target
  }
  function add(id: string, scopeId: string, status = 'active', content = '项目数据库为 SQLite', supersedes: string | null = null, scopeKind = 'project', kind = 'project_fact'): void {
    db!.prepare(`INSERT INTO memory_records (id,scope_kind,scope_id,kind,memory_key,content,status,confidence,explicitness,source_type,valid_from,valid_to,supersedes_id,created_at,updated_at,last_seen_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, scopeKind, scopeId, kind, 'database.primary', content, status, .8, scopeKind === 'global' ? 'user_explicit' : 'workspace_verified', scopeKind === 'global' ? 'user_message' : 'workspace', 1000, status === 'superseded' ? 2000 : null, supersedes, 1000, 2000, 3000)
    db!.prepare('INSERT INTO memory_evidence VALUES (?,?,?,?,?,?,?,?)').run(`e-${id}`, id, 's1', 'msg1', scopeId, 'workspace', '已确认数据库', 3000)
  }
  function objects(): string[] { return db!.prepare('SELECT name FROM sqlite_master ORDER BY name').all<{ name: string }>().map(row => row.name) }

  it('fresh schema contains only current indexes; replay and reopen are idempotent', () => {
    open()
    expect(migrateMemorySchema(db!).appliedVersions).toEqual([3])
    expect(objects()).toContain('memory_entry_index')
    expect(objects()).not.toContain('memory_records')
    expect(migrateMemorySchema(db!).appliedVersions).toEqual([])
    db!.close(); db = openBetterSqliteMemoryDb(join(root, 'memory.db'))
    expect(readMemorySchemaVersion(db)).toBe(3)
  })

  it('prepares indexes without discarding legacy records or advancing their version', () => {
    legacy(); add('mem_old', 'a'.repeat(16))
    expect(migrateMemorySchema(db!).toVersion).toBe(2)
    expect(objects()).toContain('memory_entry_index')
    expect(db!.prepare('SELECT count(*) AS n FROM memory_records').get<{ n: number }>()?.n).toBe(1)
  })

  it('exports every retained status, evidence and replacement chain before dropping old tables', () => {
    legacy()
    const scopeId = 'a'.repeat(16)
    add('mem_old', scopeId, 'superseded', '项目数据库为 MySQL')
    add('mem_new', scopeId, 'active', '项目数据库为 SQLite', 'mem_old')
    add('mem_pending', scopeId, 'pending', '可能采用新数据库')
    add('mem_verify', scopeId, 'needs_verification', '待核实数据库版本')
    add('mem_retracted', scopeId, 'retracted', '应当消失的秘密')
    add('mem_global', 'user', 'active', '个人习惯使用数据库', null, 'global', 'preference')
    const migrator = new LegacyMemoryMigrator(root, () => 4000)
    migrator.backup(); migrateMemorySchema(db!)
    expect(migrator.migrate(db!)).toEqual({ exported: 5, skipped: false })
    expect(readMemorySchemaVersion(db!)).toBe(3)
    expect(objects()).not.toContain('memory_records')
    expect(objects()).not.toContain('memory_evidence')
    expect(existsSync(join(root, 'memory.db.pre-markdown.bak'))).toBe(true)
    const dir = join(root, 'projects/_legacy', scopeId)
    const facts = parseMemoryFile(readFileSync(join(dir, 'facts.md'))).lines.filter(line => line.type === 'entry')
    expect(facts).toHaveLength(2)
    expect(facts.some(line => line.entry.metadata.verify === '1')).toBe(true)
    const current = facts.find(line => line.entry.text.includes('SQLite'))!.entry
    expect(current.metadata.id).toMatch(/^m_[a-z0-9]{10}$/)
    const archived = parseMemoryFile(readFileSync(join(dir, 'archive.md'))).lines.find(line => line.type === 'entry')!
    expect(archived.type === 'entry' && archived.entry.metadata.by_id).toBe(current.metadata.id)
    expect(parseMemoryFile(readFileSync(join(dir, 'inbox.md'))).lines.filter(line => line.type === 'entry')).toHaveLength(1)
    const ledger = parseMemoryLedger(readFileSync(join(dir, '.ledger.jsonl'), 'utf8'))
    expect(ledger.badLines).toBe(0)
    expect(reduceMemoryLedger(ledger.events, current.metadata.id!, 0)).toMatchObject({ createdAt: 1000, updatedAt: 2000, lastSeenAt: 3000, confidence: .8, evidenceCount: 1, via: 'migration' })
    expect(readFileSync(join(dir, '.ledger.jsonl'), 'utf8')).not.toContain('应当消失')
    // 被丢弃的旧表数据不应残留在库文件或 WAL 空闲页里
    expect(readFileSync(join(root, 'memory.db')).includes(Buffer.from('应当消失的秘密', 'utf8'))).toBe(false)
    const wal = join(root, 'memory.db-wal')
    if (existsSync(wal)) expect(readFileSync(wal).includes(Buffer.from('应当消失的秘密', 'utf8'))).toBe(false)
    expect(JSON.parse(readFileSync(join(root, '.migration.json'), 'utf8'))).toEqual({ version: 1, markdownMigrated: true, migratedAt: 4000, learnedEpoch: 1 })
    const snapshot = readFileSync(join(dir, 'facts.md'))
    expect(migrator.migrate(db!)).toEqual({ exported: 0, skipped: true })
    expect(readFileSync(join(dir, 'facts.md'))).toEqual(snapshot)
  })

  it('preserves handwritten notes, legacy episodes and user documents alongside exports and backups', () => {
    legacy()
    const hash = 'b'.repeat(16)
    const dir = join(root, hash)
    mkdirSync(join(dir, 'episodic'), { recursive: true })
    writeFileSync(join(dir, 'MEMORY.md'), '# Handwritten memory')
    writeFileSync(join(dir, 'notes.md'), '# Original notes')
    writeFileSync(join(dir, 'facts.md'), '# Ordinary old facts')
    writeFileSync(join(dir, 'episodic/summary.md'), '# Original episode')
    const migrator = new LegacyMemoryMigrator(root)
    migrator.backup(); migrateMemorySchema(db!); migrator.migrate(db!)
    const target = join(root, 'projects/_legacy', hash)
    expect(readFileSync(join(target, 'notes.md'), 'utf8')).toContain('# Handwritten memory')
    expect(readFileSync(join(target, 'notes.md'), 'utf8')).toContain('# Original notes')
    expect(readFileSync(join(target, 'documents/legacy/facts.md'), 'utf8')).toBe('# Ordinary old facts')
    expect(readFileSync(join(target, 'episodic/legacy.md'), 'utf8')).toBe('# Original episode')
    expect(readFileSync(join(root, '.backups/pre-markdown', hash, 'MEMORY.md'), 'utf8')).toBe('# Handwritten memory')
    expect(readFileSync(join(dir, 'MEMORY.md'), 'utf8')).toBe('# Handwritten memory')
  })

  it('validation failure restores generated files, preserves database and leaves no success marker', () => {
    legacy(); add('mem_old', 'a'.repeat(16))
    const oldDir = join(root, 'a'.repeat(16))
    const destination = join(root, 'projects/_legacy', 'a'.repeat(16), 'notes.md')
    mkdirSync(oldDir, { recursive: true })
    mkdirSync(join(root, 'projects/_legacy', 'a'.repeat(16)), { recursive: true })
    writeFileSync(join(oldDir, 'MEMORY.md'), '# Handwritten original')
    writeFileSync(join(oldDir, 'notes.md'), '# Other original notes')
    writeFileSync(destination, '# Existing destination notes')
    const migrator = new LegacyMemoryMigrator(root)
    migrator.backup(); migrateMemorySchema(db!)
    vi.spyOn(migrator, 'validateExport').mockImplementation(() => { throw new Error('validation failed') })
    expect(() => migrator.migrate(db!)).toThrow('validation failed')
    expect(readMemorySchemaVersion(db!)).toBe(2)
    expect(db!.prepare('SELECT count(*) AS n FROM memory_records').get<{ n: number }>()?.n).toBe(1)
    expect(existsSync(join(root, 'projects/_legacy', 'a'.repeat(16), 'facts.md'))).toBe(false)
    expect(existsSync(join(root, '.migration.json'))).toBe(false)
    expect(existsSync(join(root, 'memory.db.pre-markdown.bak'))).toBe(true)
    expect(readFileSync(destination, 'utf8')).toBe('# Existing destination notes')
    expect(readFileSync(join(oldDir, 'MEMORY.md'), 'utf8')).toBe('# Handwritten original')
    expect(readFileSync(join(oldDir, 'notes.md'), 'utf8')).toBe('# Other original notes')
  })

  it('migrates every allowed global category without reclassification or changing provenance', () => {
    legacy()
    for (const kind of ['convention', 'decision', 'gotcha']) add(`mem_global_${kind}`, 'user', 'active', `全局 ${kind} 约定`, null, 'global', kind)
    const migrator = new LegacyMemoryMigrator(root)
    migrator.backup(); migrateMemorySchema(db!)
    expect(migrator.migrate(db!).exported).toBe(3)
    const store = new MemoryEntryStore(root)
    const records = store.list({ scopeKind: 'global', scopeId: 'user' }).map(entry => entry.record)
    expect(records.map(record => record.kind).sort()).toEqual(['convention', 'decision', 'gotcha'])
    expect(records.every(record => record.createdAt === 1000 && record.updatedAt === 2000 && record.lastSeenAt === 3000 && record.evidenceCount === 1)).toBe(true)
    expect(readMemorySchemaVersion(db!)).toBe(3)
    expect(existsSync(join(root, 'global/preferences.md'))).toBe(false)
    expect(existsSync(join(root, 'global/conventions.md'))).toBe(true)
    expect(existsSync(join(root, 'global/decisions.md'))).toBe(true)
    expect(existsSync(join(root, 'global/gotchas.md'))).toBe(true)
    expect(existsSync(join(root, '.migration.json'))).toBe(true)
    expect(existsSync(join(root, 'memory.db.pre-markdown.bak'))).toBe(true)
  })

  it('SQL failure rolls back both tables and exported files', () => {
    legacy(); add('mem_old', 'a'.repeat(16)); migrateMemorySchema(db!)
    const failing: MemoryDb = { prepare: sql => db!.prepare(sql), close: () => {}, exec: sql => { if (sql === 'DROP TABLE IF EXISTS memory_records') throw new Error('drop failed'); db!.exec(sql) } }
    expect(() => new LegacyMemoryMigrator(root).migrate(failing)).toThrow('drop failed')
    expect(readMemorySchemaVersion(db!)).toBe(2)
    expect(objects()).toContain('memory_evidence')
    expect(existsSync(join(root, '.migration.json'))).toBe(false)
    expect(existsSync(join(root, 'projects/_legacy', 'a'.repeat(16), 'facts.md'))).toBe(false)
  })

  it('claims both drive-case hashes through policy equivalence without duplicate records or evidence', () => {
    legacy()
    const workspace = 'D:\\MemoryProject'
    const hashes = computeLegacyWorkspaceHashes(workspace)
    expect(hashes.length).toBeGreaterThan(1)
    for (let index = 0; index < hashes.length; index++) add(`mem_${index}`, hashes[index])
    const migrator = new LegacyMemoryMigrator(root)
    migrator.backup(); migrateMemorySchema(db!); migrator.migrate(db!)
    const store = new MemoryEntryStore(root)
    expect(migrator.claim(workspace, store)).toBe(hashes.length)
    const scope = { scopeKind: 'project' as const, scopeId: computeWorkspaceHash(workspace) }
    expect(store.list(scope)).toHaveLength(1)
    const record = store.list(scope)[0].record
    expect(record.content).toBe('项目数据库为 SQLite')
    expect(store.listEvidence(scope, record.id)).toHaveLength(hashes.length)
    expect(existsSync(join(getProjectMemoryDir(root, scope.scopeId, workspace), 'facts.md'))).toBe(true)
    expect(migrator.claim(workspace, store)).toBe(0)
    expect(store.listEvidence(scope, record.id)).toHaveLength(hashes.length)
  })

  it('retains ordinary document index data while exporting structured records', () => {
    legacy(); initMemorySchema(db!)
    const scope = 'a'.repeat(16)
    upsertIndexedFile(db!, scope, { relPath: 'notes.md', body: '旧库中既有记忆正文', fingerprint: '10-1', mtimeMs: 1, size: 10 })
    add('mem_old', scope)
    const migrator = new LegacyMemoryMigrator(root)
    migrator.backup(); migrateMemorySchema(db!); migrator.migrate(db!)
    expect(searchIndexed(db!, scope, '既有记忆正文', 10)[0]?.relPath).toBe('notes.md')
  })

  it('rejects future schemas before creating or modifying any objects', () => {
    open(); db!.exec('PRAGMA user_version = 4')
    expect(() => migrateMemorySchema(db!)).toThrow(MemoryMigrationError)
    expect(objects()).toEqual([])
    expect(readMemorySchemaVersion(db!)).toBe(4)
  })

  it('read-only degradation prevents source synchronization, ordinary writes and episode appends', () => {
    open(); migrateMemorySchema(db!)
    const store = new MemoryEntryStore(root)
    store.setReadOnly(true)
    const scope = { scopeKind: 'global' as const, scopeId: 'user' }
    const dir = join(root, 'global')
    mkdirSync(dir)
    writeFileSync(join(dir, 'preferences.md'), '- User draft without metadata\n')
    const service = new MemoryService(root, db!, { entryStore: store })
    expect(store.list(scope)).toEqual([])
    expect(readFileSync(join(dir, 'preferences.md'), 'utf8')).toBe('- User draft without metadata\n')
    expect(() => service.upsertMarkdown('user', 'notes.md', 'changed')).toThrow('read-only')
    expect(() => service.appendEpisodicSummary('user', 'episode')).toThrow('read-only')
    expect(existsSync(join(dir, 'notes.md'))).toBe(false)
    expect(existsSync(join(dir, '.ledger.jsonl'))).toBe(false)
  })
})
