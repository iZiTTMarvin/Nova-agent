import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openBetterSqliteMemoryDb } from '@runtime/memory/BetterSqliteMemoryDb'
import type { MemoryDb } from '@runtime/memory/MemoryDb'
import { MemoryIndex } from '@runtime/memory/index/MemoryIndex'
import { MemoryEntryStore } from '@runtime/memory/markdown/MemoryEntryStore'
import { scanScopeMarkdownFiles, reconcileScope } from '@runtime/memory/MemoryReconciler'
import { getProjectMemoryDir } from '@runtime/memory/MemoryPaths'
import { searchIndexedDocuments } from '@runtime/memory/MemoryIndexer'
import type { MemoryScope } from '@runtime/memory/types'

describe('rebuildable Markdown memory indexes', () => {
  let root: string
  let db: MemoryDb | undefined
  afterEach(() => { db?.close(); db = undefined; if (root) rmSync(root, { recursive: true, force: true }) })

  it('rebuilds equivalent scoped results after deleting the database and synchronizes edits/removals', () => {
    root = mkdtempSync(join(tmpdir(), 'nova-memory-index-'))
    const store = new MemoryEntryStore(root)
    const scope: MemoryScope = { scopeKind: 'project', scopeId: store.registerWorkspace(join(root, 'repo')) }
    store.insert({ memoryKey: null, id: 'm_0000000001', scope, kind: 'project_fact', content: '缓存前缀保持稳定', aliases: ['cache prefix'], status: 'active', explicitness: 'user_explicit', confidence: 1, sourceType: 'user_message' })
    store.insert({ memoryKey: null, id: 'm_0000000002', scope, kind: 'convention', content: 'Use structured modules', aliases: ['ghost_text'], status: 'active', explicitness: 'workspace_verified', confidence: 1, sourceType: 'workspace' })
    store.insert({ memoryKey: null, id: 'm_0000000003', scope, kind: 'gotcha', content: '缓存前缀旧结论', status: 'superseded', explicitness: 'observed', confidence: 0.8, sourceType: 'tool_result' })
    const other: MemoryScope = { scopeKind: 'project', scopeId: 'b'.repeat(16) }
    store.insert({ memoryKey: null, id: 'm_0000000004', scope: other, kind: 'project_fact', content: '缓存前缀其他项目', status: 'active', explicitness: 'user_explicit', confidence: 1, sourceType: 'user_message' })
    const path = join(root, 'memory.db')
    db = openBetterSqliteMemoryDb(path)
    let index = new MemoryIndex(db)
    index.rebuild(scope, store.list(scope))
    index.rebuild(other, store.list(other))
    const queries = ['缓存', 'cache', 'module', 'ghost_text', 'NODE_MODULE_VERSION']
    const before = queries.map(query => index.search(scope, query))
    expect(before[0].map(hit => hit.id)).toEqual(['m_0000000001'])
    expect(before[2][0].id).toBe('m_0000000002')
    expect(index.search(scope, '缓存', 30, true).map(hit => hit.id)).toContain('m_0000000003')
    db.close(); db = undefined
    rmSync(path)
    db = openBetterSqliteMemoryDb(path)
    index = new MemoryIndex(db)
    expect(index.isDirty(scope)).toBe(true)
    index.rebuild(scope, store.list(scope))
    expect(queries.map(query => index.search(scope, query))).toEqual(before)
    const failingDb: MemoryDb = {
      sqliteVersion: db.sqliteVersion,
      exec: sql => db!.exec(sql),
      prepare: sql => {
        if (sql.startsWith('INSERT INTO memory_entry_index(')) throw new Error('index disk failure')
        return db!.prepare(sql)
      },
      close: () => db!.close()
    }
    const failingIndex = new MemoryIndex(failingDb)
    expect(() => failingIndex.rebuild(scope, store.list(scope))).toThrow('index disk failure')
    expect(failingIndex.isDirty(scope)).toBe(true)
    expect(index.readPreviousEntries(scope).map(entry => entry.id)).toEqual(['m_0000000001', 'm_0000000002', 'm_0000000003'])
    index.rebuild(scope, store.list(scope))
    expect(queries.map(query => index.search(scope, query))).toEqual(before)
    index.markDirty(scope)
    expect(() => index.search(scope, '缓存')).toThrow('requires rebuild')
    store.purge(scope, 'm_0000000001')
    index.rebuild(scope, store.list(scope))
    expect(index.search(scope, '缓存')).toEqual([])
    index.rebuild(scope, store.list(scope))
    expect(index.search(scope, 'ghost_text')[0].id).toBe('m_0000000002')
  })

  it('excludes managed files and hidden backups while preserving ordinary global documents and terms updates', () => {
    root = mkdtempSync(join(tmpdir(), 'nova-memory-doc-index-'))
    const scopeId = 'a'.repeat(16)
    const dir = getProjectMemoryDir(root, scopeId)
    mkdirSync(join(dir, '.backup'), { recursive: true })
    for (const name of ['MEMORY.md', 'facts.md', 'inbox.md', 'archive.md', 'notes.md']) writeFileSync(join(dir, name), '缓存 NODE_MODULE_VERSION running modules')
    writeFileSync(join(dir, '.backup', 'private.md'), 'hidden backup')
    expect(scanScopeMarkdownFiles(dir).map(file => file.relPath)).toEqual(['notes.md'])
    const global = join(root, 'global')
    mkdirSync(global)
    writeFileSync(join(global, 'notes.md'), '全局普通文档')
    writeFileSync(join(global, 'gotchas.md'), '全局托管经验')
    writeFileSync(join(global, 'preferences.md'), '全局托管')
    expect(scanScopeMarkdownFiles(global, 'global').map(file => file.relPath)).toEqual(['notes.md'])
    db = openBetterSqliteMemoryDb(join(root, 'memory.db'))
    reconcileScope(db, scopeId, dir)
    expect(searchIndexedDocuments(db, scopeId, '缓存', 10)[0].relPath).toBe('notes.md')
    expect(searchIndexedDocuments(db, scopeId, 'module', 10)[0].relPath).toBe('notes.md')
    expect(searchIndexedDocuments(db, scopeId, 'NODE_MODULE_VERSION', 10)[0].relPath).toBe('notes.md')
    writeFileSync(join(dir, 'notes.md'), 'replacement unique')
    reconcileScope(db, scopeId, dir)
    expect(searchIndexedDocuments(db, scopeId, '缓存', 10)).toEqual([])
    expect(searchIndexedDocuments(db, scopeId, 'replacement', 10)).toHaveLength(1)
    rmSync(join(dir, 'notes.md'))
    reconcileScope(db, scopeId, dir)
    expect(searchIndexedDocuments(db, scopeId, 'replacement', 10)).toEqual([])
  })
})
