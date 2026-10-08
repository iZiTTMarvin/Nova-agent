import { createHash } from 'node:crypto'
import type { MemoryDb } from '../MemoryDb'
import type { MemoryScope } from '../types'
import type { StoredMemoryEntry } from '../markdown/MemoryEntryStore'
import { buildIndexTerms, buildMemoryIndexQuery, mergeLexicalHits, type LexicalHit } from './indexTerms'
import { MEMORY_LITERAL_BONUS } from '../memoryConfig'

export const MEMORY_INDEX_SCHEMA = `
CREATE TABLE IF NOT EXISTS memory_index_meta (scope_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, dirty INTEGER NOT NULL DEFAULT 0, rebuilt_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS memory_entry_index (
  rowid INTEGER PRIMARY KEY, id TEXT NOT NULL, scope_kind TEXT NOT NULL, scope_id TEXT NOT NULL,
  kind TEXT NOT NULL, status TEXT NOT NULL, rel_path TEXT NOT NULL, memory_key TEXT,
  content TEXT NOT NULL, aliases TEXT NOT NULL, explicitness TEXT NOT NULL, confidence REAL NOT NULL,
  pinned INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  source_path TEXT, source_fingerprint TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS memory_entry_index_id ON memory_entry_index(scope_id, id);
CREATE VIRTUAL TABLE IF NOT EXISTS memory_entry_terms USING fts5(terms, content='', tokenize='porter unicode61 remove_diacritics 2');
CREATE VIRTUAL TABLE IF NOT EXISTS memory_entry_tri USING fts5(text, content='', tokenize='trigram');
CREATE VIRTUAL TABLE IF NOT EXISTS memory_files_terms USING fts5(terms, content='', tokenize='porter unicode61 remove_diacritics 2');
`

interface IndexRow { rowid: number; content: string; aliases: string; memory_key: string | null }
const indexText = (row: Pick<IndexRow, 'content' | 'aliases' | 'memory_key'>): string => `${row.content} ${row.aliases} ${row.memory_key ?? ''}`

export class MemoryIndex {
  private readonly dirtyScopes = new Set<string>()
  constructor(private readonly db: MemoryDb, private readonly now: () => number = Date.now, private readonly literalBonus = MEMORY_LITERAL_BONUS) {
    if (!Number.isFinite(literalBonus) || literalBonus < 0 || literalBonus > 1) throw new Error('Invalid memory literal bonus')
    db.exec(MEMORY_INDEX_SCHEMA)
  }

  markDirty(scope: MemoryScope): void {
    this.dirtyScopes.add(scope.scopeId)
    this.db.prepare(`INSERT INTO memory_index_meta(scope_id, fingerprint, dirty, rebuilt_at) VALUES (?, '', 1, 0)
      ON CONFLICT(scope_id) DO UPDATE SET dirty=1`).run(scope.scopeId)
  }

  isDirty(scope: MemoryScope): boolean {
    return this.dirtyScopes.has(scope.scopeId) || this.db.prepare('SELECT dirty FROM memory_index_meta WHERE scope_id=?').get<{ dirty: number }>(scope.scopeId)?.dirty !== 0
  }

  readPreviousEntries(scope: MemoryScope): { id: string; content: string }[] {
    return this.db.prepare('SELECT id, content FROM memory_entry_index WHERE scope_id=? ORDER BY rowid').all<{ id: string; content: string }>(scope.scopeId)
  }

  rebuild(scope: MemoryScope, entries: readonly StoredMemoryEntry[]): void {
    this.dirtyScopes.add(scope.scopeId)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const row of this.db.prepare('SELECT rowid, content, aliases, memory_key FROM memory_entry_index WHERE scope_id=?').all<IndexRow>(scope.scopeId)) {
        const text = indexText(row)
        this.db.prepare("INSERT INTO memory_entry_terms(memory_entry_terms,rowid,terms) VALUES ('delete',?,?)").run(row.rowid, buildIndexTerms(text))
        this.db.prepare("INSERT INTO memory_entry_tri(memory_entry_tri,rowid,text) VALUES ('delete',?,?)").run(row.rowid, text)
      }
      this.db.prepare('DELETE FROM memory_entry_index WHERE scope_id=?').run(scope.scopeId)
      const insert = this.db.prepare(`INSERT INTO memory_entry_index(id,scope_kind,scope_id,kind,status,rel_path,memory_key,content,aliases,explicitness,confidence,pinned,last_seen_at,created_at,updated_at,source_path,source_fingerprint) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      for (const entry of entries) {
        const record = entry.record
        const aliases = entry.aliases.join(' ')
        insert.run(record.id, scope.scopeKind, scope.scopeId, record.kind, record.status, entry.relPath, record.memoryKey ?? null, record.content, aliases, record.explicitness, record.confidence, Number(entry.pinned), record.lastSeenAt, record.createdAt, record.updatedAt, record.sourcePath ?? null, record.sourceFingerprint ?? null)
        const row = this.db.prepare('SELECT rowid FROM memory_entry_index WHERE scope_id=? AND id=?').get<{ rowid: number }>(scope.scopeId, record.id)
        if (!row) throw new Error('Memory index insert did not produce a row')
        const text = `${record.content} ${aliases} ${record.memoryKey ?? ''}`
        this.db.prepare('INSERT INTO memory_entry_terms(rowid,terms) VALUES (?,?)').run(row.rowid, buildIndexTerms(text))
        this.db.prepare('INSERT INTO memory_entry_tri(rowid,text) VALUES (?,?)').run(row.rowid, text)
      }
      const fingerprint = createHash('sha256').update(JSON.stringify(entries)).digest('hex')
      this.db.prepare(`INSERT INTO memory_index_meta(scope_id,fingerprint,dirty,rebuilt_at) VALUES (?,?,0,?) ON CONFLICT(scope_id) DO UPDATE SET fingerprint=excluded.fingerprint,dirty=0,rebuilt_at=excluded.rebuilt_at`).run(scope.scopeId, fingerprint, this.now())
      this.db.exec('COMMIT')
      this.dirtyScopes.delete(scope.scopeId)
    } catch (error) {
      this.db.exec('ROLLBACK')
      try { this.markDirty(scope) } catch { /* The in-memory dirty flag survives an unavailable database. */ }
      throw error
    }
  }

  /**
   * 合并 contentless FTS5 段以物理清除已删除条目的倒排残留，再截断 WAL。
   * 普通查询命中靠 rowid 关联，残留只在原始字节层面存在，必须显式清理。
   */
  purgeResidue(): void {
    this.db.prepare(`INSERT INTO memory_entry_terms(memory_entry_terms) VALUES('optimize')`).run()
    this.db.prepare(`INSERT INTO memory_entry_tri(memory_entry_tri) VALUES('optimize')`).run()
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  }

  search(scope: MemoryScope, query: string, limit = 30, history = false): LexicalHit[] {
    return this.searchScopes([scope], query, limit, history).get(scope.scopeId) ?? []
  }

  searchScopes(scopes: readonly MemoryScope[], query: string, limit = 30, history = false): Map<string, LexicalHit[]> {
    for (const scope of scopes) if (this.isDirty(scope)) throw new Error(`Memory index requires rebuild: ${scope.scopeId}`)
    if (!scopes.length) return new Map()
    const built = buildMemoryIndexQuery(query)
    const fetch = (table: 'memory_entry_terms' | 'memory_entry_tri', match: string | null): (LexicalHit & { scopeId: string })[] => match ? scopes.flatMap(scope => this.db.prepare(`SELECT e.id, e.scope_id AS scopeId, -bm25(${table}) AS score FROM ${table} JOIN memory_entry_index e ON e.rowid=${table}.rowid WHERE ${table} MATCH ? AND e.scope_id=? AND ${history ? "e.status != 'pending'" : "e.status = 'active'"} ORDER BY bm25(${table}) LIMIT ?`).all<LexicalHit & { scopeId: string }>(match, scope.scopeId, limit)) : []
    const terms = fetch('memory_entry_terms', built.terms)
    const literal = fetch('memory_entry_tri', built.literal)
    const normalizers = { terms: Math.max(0, ...terms.map(hit => hit.score)), literal: Math.max(0, ...literal.map(hit => hit.score)) }
    return new Map(scopes.map(scope => [scope.scopeId, mergeLexicalHits(terms.filter(hit => hit.scopeId === scope.scopeId), literal.filter(hit => hit.scopeId === scope.scopeId), normalizers, this.literalBonus).slice(0, limit)]))
  }
}
