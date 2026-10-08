import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appendFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { MemoryEntryStore, type MemoryEntryInsert } from '@runtime/memory/markdown/MemoryEntryStore'
import { MemoryFileConflictError, writeFileAtomic } from '@runtime/memory/markdown/atomicFile'
import { GLOBAL_SCOPE_ID, getProjectMemoryDir } from '@runtime/memory/MemoryPaths'
import { MEMORY_FILE_HEADER, parseMemoryFile } from '@runtime/memory/markdown/entryFormat'
import type { MemoryScope } from '@runtime/memory/types'

const id = 'm_0000000001'
const successor = 'm_0000000002'
const global: MemoryScope = { scopeKind: 'global', scopeId: GLOBAL_SCOPE_ID }

describe('Markdown memory facts and user edits', () => {
  let root: string
  let store: MemoryEntryStore
  let scope: MemoryScope
  let dir: string
  let clock: number
  let seq: number

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'nova-entry-store-'))
    clock = new Date(2026, 9, 8, 12).getTime()
    seq = 100
    store = new MemoryEntryStore(root, { now: () => clock, generateId: () => `m_${String(seq++).padStart(10, '0')}` })
    const workspace = join(root, 'nova')
    scope = { scopeKind: 'project', scopeId: store.registerWorkspace(workspace) }
    dir = getProjectMemoryDir(root, scope.scopeId, workspace)
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  const draft = (overrides: Partial<MemoryEntryInsert> = {}): MemoryEntryInsert => ({
    id, scope, kind: 'convention', memoryKey: 'commit.style', content: '提交信息使用中文 Conventional Commits',
    status: 'active', confidence: 1, explicitness: 'user_explicit', sourceType: 'user_message',
    aliases: ['commit', '提交'], evidence: [{ evidenceType: 'user_message', sessionId: 's1', projectScopeId: scope.scopeId, excerpt: '以后提交信息使用中文 Conventional Commits' }],
    ...overrides
  })

  it('managed editor writes synchronize user edits and roll back the file when provenance fails', () => {
    store.insert(draft({ explicitness: 'observed' }))
    const before = readFileSync(join(dir, 'conventions.md'), 'utf8')
    const failing = new MemoryEntryStore(root, { now: () => clock, appendLedgerFile: () => { throw new Error('editor ledger failure') } })
    failing.registerWorkspace(join(root, 'nova'))
    failing.list(scope)
    expect(() => failing.writeManagedFile(scope, 'conventions.md', before + '- 新手写的约定必须保留独立 provenance\n')).toThrow('editor ledger failure')
    expect(readFileSync(join(dir, 'conventions.md'), 'utf8')).toBe(before)
    expect(store.writeManagedFile(scope, 'conventions.md', before.replace('提交信息使用中文 Conventional Commits', '手动更改后的提交约定必须保留中文'))).toBe(0)
    expect(store.find(id, scope)?.record).toMatchObject({ content: '手动更改后的提交约定必须保留中文', explicitness: 'user_explicit' })
    expect(readFileSync(join(dir, 'MEMORY.md'), 'utf8')).toContain('手动更改后的提交约定必须保留中文')
  })

  it('persists active and pending entries with one provenance owner and no duplicated content in the ledger', () => {
    expect(store.insert(draft()).status).toBe('active')
    store.insert(draft({ id: successor, status: 'pending', explicitness: 'observed', kind: 'gotcha', content: 'Windows 文件占用可能导致原子替换失败' }))
    expect(readFileSync(join(dir, 'conventions.md'), 'utf8')).toContain('aliases=commit,')
    expect(readFileSync(join(dir, 'inbox.md'), 'utf8')).toContain('kind=gotcha')
    expect(store.list(scope).map(entry => entry.record.status)).toEqual(['active', 'pending'])
    expect(store.list(scope)[0].record).toMatchObject({ evidenceCount: 1, distinctSessionCount: 1, distinctProjectCount: 1 })
    expect(existsSync(join(dir, 'MEMORY.md'))).toBe(true)
    expect(readFileSync(join(dir, '.ledger.jsonl'), 'utf8')).not.toContain('"content"')
  })

  it('merges evidence without changing text and promotes inbox entries', () => {
    store.insert(draft({ status: 'pending', explicitness: 'observed' }))
    clock += 24 * 60 * 60 * 1000
    expect(store.mergeEvidence(scope, id, {
      evidence: [{ evidenceType: 'user_message', sessionId: 's2', projectScopeId: scope.scopeId, excerpt: '仍然使用中文提交信息' }],
      confidence: 0.95, lastSeenAt: clock
    })).toBe(true)
    expect(store.updateStatus(scope, id, 'active')).toBe(true)
    const entry = store.find(id, scope)!
    expect(entry.record).toMatchObject({ status: 'active', evidenceCount: 2, distinctSessionCount: 2, content: draft().content })
    expect(readFileSync(join(dir, 'inbox.md'), 'utf8')).not.toContain(id)
    expect(readFileSync(join(dir, 'conventions.md'), 'utf8')).not.toContain('kind=convention')
    expect(readFileSync(join(dir, 'conventions.md'), 'utf8')).toContain('seen=2026-10-09')
  })

  it('supersedes at the original position, archives history and reconstructs the replacement chain', () => {
    store.insert(draft())
    appendFileSync(join(dir, 'conventions.md'), 'User tail paragraph\n')
    store.supersede(scope, id, draft({ id: successor, content: '提交信息统一使用英文 Conventional Commits' }))
    const topic = readFileSync(join(dir, 'conventions.md'), 'utf8')
    expect(topic.indexOf('英文')).toBeLessThan(topic.indexOf('User tail paragraph'))
    expect(topic).not.toContain(id)
    expect(readFileSync(join(dir, 'archive.md'), 'utf8')).toContain(`status=superseded until=2026-10-08 by_id=${successor}`)
    expect(store.find(successor, scope)?.record.supersedesId).toBe(id)
    expect(store.find(id, scope)?.record.status).toBe('superseded')
  })

  it('supports archival retraction, complete purge, pinning, verification and re-confirmation', () => {
    store.insert(draft())
    store.setPinned(scope, id, true)
    expect(store.find(id, scope)?.pinned).toBe(true)
    store.setPinned(scope, id, false)
    store.updateStatus(scope, id, 'needs_verification')
    expect(store.find(id, scope)?.record.status).toBe('needs_verification')
    expect(readFileSync(join(dir, 'conventions.md'), 'utf8')).toContain('verify=1')
    store.mergeEvidence(scope, id, { evidence: [] })
    expect(store.find(id, scope)?.record.status).toBe('active')
    store.updateStatus(scope, id, 'retracted')
    expect(store.find(id, scope)?.location).toBe('archive')
    expect(store.purge(scope, id)).toBe(true)
    expect(store.find(id, scope)).toBeNull()
    for (const file of readdirSync(dir).filter(file => file.endsWith('.md') || file.endsWith('.jsonl'))) {
      expect(readFileSync(join(dir, file), 'utf8')).not.toContain(id)
    }
    expect(readFileSync(join(dir, 'conventions.md'), 'utf8')).toContain(MEMORY_FILE_HEADER)
  })

  it('purge removes damaged lines by their metadata id but keeps user text that only mentions the id', () => {
    store.list(scope)
    const mention = `- 格式示例：id=${id} 这种写法要保留  <!-- by=bogus -->`
    writeFileSync(join(dir, 'conventions.md'), `${MEMORY_FILE_HEADER}\n# Conventions\n\n- 损坏条目  <!-- id=${id} by=bogus added=2026-10-08 -->\n${mention}\n`)
    expect(store.purge(scope, id)).toBe(true)
    const topic = readFileSync(join(dir, 'conventions.md'), 'utf8')
    expect(topic).not.toContain('损坏条目')
    expect(topic).toContain(mention)
  })

  it('approves inbox entries as user facts and rejects by purging', () => {
    store.insert(draft({ status: 'pending', explicitness: 'inferred' }))
    expect(store.approve(scope, id)).toBe(true)
    expect(store.find(id, scope)?.record).toMatchObject({ status: 'active', explicitness: 'user_explicit' })
    store.insert(draft({ id: successor, status: 'pending' }))
    expect(store.purge(scope, successor)).toBe(true)
    expect(store.list(scope, 'inbox')).toEqual([])
  })

  it('assigns hand-added and duplicated IDs, preserves other bytes and detects edits/moves/deletion', () => {
    store.insert(draft({ explicitness: 'workspace_verified', sourceType: 'workspace', sourcePath: 'package.json', sourceFingerprint: '20-100' }))
    const path = join(dir, 'conventions.md')
    const source = readFileSync(path, 'utf8')
    const rawEntry = source.split('\n').find(line => line.startsWith('- '))!
    writeFileSync(path, source.replace(draft().content, '用户修改后的规范内容') + rawEntry + '\n- 用户手动增加的规范\n- 坏行  <!-- broken -->\nUser paragraph\n')
    const entries = store.reconcile(scope)
    expect(entries).toHaveLength(3)
    expect(new Set(entries.map(entry => entry.record.id)).size).toBe(3)
    expect(entries[0].record).toMatchObject({ explicitness: 'user_explicit', sourcePath: null, sourceFingerprint: null })
    const corrected = readFileSync(path, 'utf8')
    expect(corrected).toContain('- 坏行  <!-- broken -->\nUser paragraph\n')
    expect(store.stats(scope).parseIssues).toBe(1)
    const firstLine = corrected.split('\n').find(line => line.includes(`id=${id}`))!
    writeFileSync(path, corrected.replace(firstLine + '\n', ''))
    writeFileSync(join(dir, 'gotchas.md'), `${MEMORY_FILE_HEADER}\n# Gotchas\n${firstLine}\n`)
    expect(store.find(id, scope)?.record.kind).toBe('gotcha')
    writeFileSync(join(dir, 'gotchas.md'), `${MEMORY_FILE_HEADER}\n# Gotchas\n`)
    store.reconcile(scope)
    expect(readFileSync(join(dir, '.ledger.jsonl'), 'utf8')).not.toContain(id)
  })

  it('reassigns copied project IDs and manages global conventions while excluding project facts', () => {
    store.insert(draft({ kind: 'preference' }))
    const globalDir = join(root, 'global')
    mkdirSync(globalDir, { recursive: true })
    writeFileSync(join(globalDir, 'preferences.md'), readFileSync(join(dir, 'preferences.md')))
    writeFileSync(join(globalDir, 'conventions.md'), '- 全局提交约定\n')
    writeFileSync(join(globalDir, 'facts.md'), '- 普通全局文档内容\n')
    const entries = store.list(global)
    expect(entries).toHaveLength(2)
    expect(entries.find(entry => entry.record.kind === 'preference')!.record.id).not.toBe(id)
    expect(entries.find(entry => entry.record.kind === 'convention')!.record.content).toBe('全局提交约定')
    expect(store.find(id, scope)).not.toBeNull()
    expect(readFileSync(join(globalDir, 'facts.md'), 'utf8')).toBe('- 普通全局文档内容\n')
    expect(() => store.insert(draft({ scope: global, kind: 'project_fact' }))).toThrow('Global memory')
  })

  it('keeps unchanged files byte-stable and returns detached projections', () => {
    store.insert(draft())
    const path = join(dir, 'conventions.md')
    const source = readFileSync(path, 'utf8')
    const entries = store.list(scope)
    entries[0].aliases.push('mutated')
    entries[0].record.content = 'mutated'
    store.list(scope)
    expect(readFileSync(path, 'utf8')).toBe(source)
    expect(store.find(id, scope)?.aliases).toEqual(['commit', '提交'])
    expect(store.find(id, scope)?.record.content).toBe(draft().content)
  })

  it('rolls back topic changes when archive writing fails', () => {
    store.insert(draft())
    const before = readFileSync(join(dir, 'conventions.md'), 'utf8')
    const ledgerBefore = readFileSync(join(dir, '.ledger.jsonl'), 'utf8')
    const failing = new MemoryEntryStore(root, { now: () => clock, writeFile: (path, content, options) => {
      if (basename(path) === 'archive.md') throw new Error('archive disk error')
      writeFileAtomic(path, content, options)
    } })
    expect(() => failing.supersede(scope, id, draft({ id: successor }))).toThrow('archive disk error')
    expect(readFileSync(join(dir, 'conventions.md'), 'utf8')).toBe(before)
    expect(readFileSync(join(dir, '.ledger.jsonl'), 'utf8')).toBe(ledgerBefore)
    expect(existsSync(join(dir, 'archive.md'))).toBe(false)
  })

  it('rolls back topic and partially appended provenance when ledger append fails', () => {
    store.insert(draft())
    const before = readFileSync(join(dir, 'conventions.md'), 'utf8')
    const ledgerBefore = readFileSync(join(dir, '.ledger.jsonl'), 'utf8')
    const failing = new MemoryEntryStore(root, { now: () => clock, appendLedgerFile: (path) => {
      appendFileSync(path, 'partial data')
      throw new Error('ledger disk error')
    } })
    expect(() => failing.insert(draft({ id: successor }))).toThrow('ledger disk error')
    expect(readFileSync(join(dir, 'conventions.md'), 'utf8')).toBe(before)
    expect(readFileSync(join(dir, '.ledger.jsonl'), 'utf8')).toBe(ledgerBefore)
  })

  it('keeps facts successful when index or generated view updates fail', () => {
    const onError = vi.fn()
    const degraded = new MemoryEntryStore(root, {
      now: () => clock, onError,
      onIndexChanged: () => { throw new Error('index failed') },
      writeFile: (path, content, options) => {
        if (basename(path) === 'MEMORY.md') throw new Error('view failed')
        writeFileAtomic(path, content, options)
      }
    })
    expect(degraded.insert(draft()).id).toBe(id)
    expect(degraded.find(id, scope)?.record.content).toBe(draft().content)
    expect(new Set(onError.mock.calls.map(call => call[0]))).toEqual(new Set(['index', 'view']))
  })

  it('re-synchronizes external edits and retries a conflict once', () => {
    store.insert(draft())
    let conflicts = 0
    const conflicting = new MemoryEntryStore(root, {
      now: () => clock,
      writeFile: (path, content, options) => {
        if (basename(path) === 'conventions.md' && conflicts++ === 0) {
          const existing = readFileSync(path, 'utf8')
          writeFileSync(path, existing.replace(draft().content, '用户在外部编辑器更新的规范内容'))
          throw new MemoryFileConflictError(path)
        }
        writeFileAtomic(path, content, options)
      }
    })
    expect(conflicting.setPinned(scope, id, true)).toBe(true)
    expect(conflicting.find(id, scope)).toMatchObject({ pinned: true, record: { content: '用户在外部编辑器更新的规范内容', explicitness: 'user_explicit' } })
    const alwaysConflict = new MemoryEntryStore(root, { now: () => clock, writeFile: (path, content, options) => {
      if (basename(path) === 'conventions.md') throw new MemoryFileConflictError(path)
      writeFileAtomic(path, content, options)
    } })
    expect(() => alwaysConflict.setPinned(scope, id, false)).toThrow(MemoryFileConflictError)
    expect(store.find(id, scope)?.pinned).toBe(true)
  })

  it('does not rewrite unknown versions or erase their provenance', () => {
    store.insert(draft())
    const path = join(dir, 'conventions.md')
    const source = readFileSync(path, 'utf8').replace('nova-memory v1', 'nova-memory v2')
    writeFileSync(path, source)
    const ledgerBefore = readFileSync(join(dir, '.ledger.jsonl'), 'utf8')
    expect(parseMemoryFile(source).readOnly).toBe(true)
    expect(() => store.purge(scope, id)).toThrow('read-only')
    expect(readFileSync(path, 'utf8')).toBe(source)
    expect(readFileSync(join(dir, '.ledger.jsonl'), 'utf8')).toBe(ledgerBefore)
  })

  it('uses the previous index projection to detect user edits after restarting', () => {
    store.insert(draft({ explicitness: 'workspace_verified', sourceType: 'workspace', sourcePath: 'package.json', sourceFingerprint: '20-100' }))
    const path = join(dir, 'conventions.md')
    writeFileSync(path, readFileSync(path, 'utf8').replace(draft().content, '用户重启前手动更新后的项目规范'))
    const restarted = new MemoryEntryStore(root, {
      now: () => clock, readPreviousEntries: () => [{ id, content: draft().content }]
    })
    expect(restarted.find(id, scope)?.record).toMatchObject({
      content: '用户重启前手动更新后的项目规范', explicitness: 'user_explicit', sourcePath: null, sourceFingerprint: null
    })
  })

  it('reports failed rollback rather than overwriting a concurrent external edit', () => {
    store.insert(draft())
    const failing = new MemoryEntryStore(root, { now: () => clock, writeFile: (path, content, options) => {
      if (basename(path) === 'archive.md') {
        writeFileSync(join(dir, 'conventions.md'), 'external editor data\n')
        throw new Error('archive disk error')
      }
      writeFileAtomic(path, content, options)
    } })
    expect(() => failing.supersede(scope, id, draft({ id: successor }))).toThrow(AggregateError)
    expect(readFileSync(join(dir, 'conventions.md'), 'utf8')).toBe('external editor data\n')
    expect(existsSync(join(dir, 'archive.md'))).toBe(false)
  })
})
