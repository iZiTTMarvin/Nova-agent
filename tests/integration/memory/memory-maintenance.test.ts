import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, utimesSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openBetterSqliteMemoryDb } from '@runtime/memory/BetterSqliteMemoryDb'
import { createMarkdownMemoryFixture } from '../../fixtures/memory/MarkdownMemoryFixture'
import type { MemoryEntryInsert } from '@runtime/memory/markdown/MemoryEntryStore'
import { getProjectMemoryDir } from '@runtime/memory/MemoryPaths'
import { LegacyMemoryMigrator } from '@runtime/memory/migration/LegacyMemoryMigrator'
import { maintainMemoryFiles } from '@runtime/memory/maintenance/maintainFiles'
import { MEMORY_BACKUP_KEEP } from '@runtime/memory/memoryConfig'

const day = 86_400_000
describe('memory maintenance with real files and SQLite projection', () => {
  let root: string, clock: number, fixture: ReturnType<typeof createMarkdownMemoryFixture>, db: ReturnType<typeof openBetterSqliteMemoryDb>, seq: number
  let scope: MemoryEntryInsert['scope'], dir: string, failLedger: boolean
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'nova-memory-maintenance-')); clock = new Date(2026, 9, 8).getTime(); seq = 1; failLedger = false
    db = openBetterSqliteMemoryDb(join(root, 'memory.db'))
    fixture = createMarkdownMemoryFixture(root, db, () => clock, { appendLedgerFile: (...args) => { if (failLedger) throw new Error('injected ledger failure'); return appendFileSync(...args) } })
    const workspace = join(root, 'workspace')
    scope = { scopeKind: 'project', scopeId: fixture.store.registerWorkspace(workspace) }
    dir = getProjectMemoryDir(root, scope.scopeId, workspace)
  })
  afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }) })
  function insert(overrides: Partial<MemoryEntryInsert> = {}) {
    const draft: MemoryEntryInsert = { id: `m_${String(seq++).padStart(10, '0')}`, scope, kind: 'convention', memoryKey: null, content: '未来提交统一使用中文并说明必要原因', status: 'active', confidence: .8, explicitness: 'observed', sourceType: 'user_message', via: 'extract', ...overrides }
    return fixture.store.insert(draft)
  }
  function bytes() {
    return Object.fromEntries(['conventions.md', 'inbox.md', 'archive.md', '.ledger.jsonl', 'MEMORY.md'].map(path => [path, existsSync(join(dir, path)) ? readFileSync(join(dir, path)).toString('base64') : null]))
  }
  function organize(plan: unknown) {
    const input = fixture.store.topicMaintenanceInput(scope, 'conventions.md')
    fixture.store.organize(scope, 'conventions.md', plan, input.fingerprint)
  }

  it('inbox and archive retain exact TTL boundaries and purge provenance/index beyond them', () => {
    clock -= 60 * day
    const pending = insert({ status: 'pending' })
    clock -= 30 * day
    const archived = insert({ status: 'retracted' })
    clock += 90 * day
    expect(fixture.store.maintain(scope)).toBe(0)
    expect(fixture.store.list(scope).map(entry => entry.record.id)).toEqual([pending.id, archived.id])
    clock += 1
    expect(fixture.store.maintain(scope)).toBe(2)
    expect(fixture.store.list(scope)).toEqual([])
    expect(fixture.repository.listEvidence(pending.id)).toEqual([])
    expect(fixture.repository.searchFts('提交', { scope, status: 'any' })).toEqual([])
    expect(readFileSync(join(dir, '.ledger.jsonl'), 'utf8')).not.toContain(pending.id)
  })

  it('inbox capacity removes the oldest observations while active user entries remain', () => {
    const user = insert({ explicitness: 'user_explicit', via: 'user-edit' })
    const ids: string[] = []
    for (let i = 0; i < 102; i++) { clock++; ids.push(insert({ status: 'pending' }).id) }
    expect(fixture.store.maintain(scope)).toBe(2)
    expect(fixture.store.list(scope, 'inbox').map(entry => entry.record.id)).toEqual(ids.slice(2))
    expect(fixture.store.find(user.id, scope)?.record.content).toBe(user.content)
  })

  it('invalid plans change no fact/view/provenance bytes, including protected or overlapping IDs', () => {
    const user = insert({ explicitness: 'user_explicit', memoryKey: 'first' }), observed = insert({ memoryKey: 'second', pinned: true }), other = insert({ memoryKey: 'other' })
    fixture.store.topicMaintenanceInput(scope, 'conventions.md')
    const original = bytes()
    const group = { ids: [user.id, observed.id], content: '未来提交统一使用中文并说明必要原因', key: 'merged', aliases: ['commit', '提交'] }
    for (const plan of [
      { merge: [], retire: [user.id] }, { merge: [], retire: [observed.id] },
      { merge: [{ ...group, ids: [user.id, 'm_9999999999'] }], retire: [] },
      { merge: [{ ...group, ids: [user.id, user.id] }], retire: [] },
      { merge: [group, { ...group, ids: [observed.id, other.id] }], retire: [] },
      { merge: [group], retire: [observed.id] },
      { merge: [{ ...group, content: '保存 api_key=sk-fictionalfixturevalue000000001' }], retire: [] },
      { merge: [{ ...group, key: 'other' }], retire: [] }
    ]) {
      expect(() => organize(plan)).toThrow()
      expect(bytes()).toEqual(original)
      expect(existsSync(join(dir, '.backups'))).toBe(false)
    }
  })

  it('merges at the first original position, preserves strongest provenance/pin and archives replacement links', () => {
    const first = insert({ explicitness: 'user_explicit', memoryKey: 'first', evidence: [{ evidenceType: 'user_message', sessionId: 's1', excerpt: '未来提交统一使用中文并说明必要原因' }] })
    const untouched = insert({ memoryKey: 'untouched', content: '项目发布之前应先核对文件清单' })
    const second = insert({ pinned: true, memoryKey: 'second', evidence: [{ evidenceType: 'user_message', sessionId: 's2', excerpt: '中文提交需要说明必要原因和约束' }] })
    fixture.store.topicMaintenanceInput(scope, 'conventions.md')
    const before = bytes()
    organize({ merge: [{ ids: [second.id, first.id], content: '提交信息使用中文并说明原因及约束', key: 'merged', aliases: ['commit', '提交'] }], retire: [] })
    const active = fixture.store.list(scope, 'topics'), merged = active[0]
    expect(active.map(entry => entry.record.memoryKey)).toEqual(['merged', 'untouched'])
    expect(merged.record).toMatchObject({ explicitness: 'user_explicit', evidenceCount: 2, distinctSessionCount: 2 })
    expect(merged.pinned).toBe(true)
    expect(active[1].record.id).toBe(untouched.id)
    for (const old of [first, second]) {
      expect(fixture.store.find(old.id, scope)?.record.status).toBe('superseded')
      expect(readFileSync(join(dir, 'archive.md'), 'utf8')).toContain(`by_id=${merged.record.id}`)
    }
    expect(fixture.repository.searchFts('约束', { scope }).map(hit => hit.record.id)).toEqual([merged.record.id])
    expect(readFileSync(join(dir, 'MEMORY.md'), 'utf8')).toContain('提交信息使用中文并说明原因及约束')
    const backups = readdirSync(join(dir, '.backups'))
    expect(backups).toHaveLength(1)
    const saved = JSON.parse(readFileSync(join(dir, '.backups', backups[0]), 'utf8')).files
    expect(saved).toEqual({ 'conventions.md': before['conventions.md'], 'archive.md': before['archive.md'], '.ledger.jsonl': before['.ledger.jsonl'] })
  })

  it('ledger failure restores every original byte and removes the failed backup; stale model plans cannot overwrite manual edits', () => {
    const first = insert(), second = insert()
    const input = fixture.store.topicMaintenanceInput(scope, 'conventions.md'), original = bytes()
    const plan = { merge: [{ ids: [first.id, second.id], content: '提交信息保持中文并充分说明必要原因', key: null, aliases: [] }], retire: [] }
    failLedger = true
    expect(() => fixture.store.organize(scope, 'conventions.md', plan, input.fingerprint)).toThrow('injected ledger failure')
    expect(bytes()).toEqual(original)
    expect(readdirSync(join(dir, '.backups'))).toEqual([])
    failLedger = false
    const fresh = fixture.store.topicMaintenanceInput(scope, 'conventions.md')
    const path = join(dir, 'conventions.md'); writeFileSync(path, readFileSync(path, 'utf8').replace(first.content, '用户手动添加的重要限制必须原样保留'))
    const edited = bytes()
    expect(() => fixture.store.organize(scope, 'conventions.md', plan, fresh.fingerprint)).toThrow('Memory file changed')
    expect(readFileSync(path).toString('base64')).toBe(edited['conventions.md'])
    expect(fixture.store.find(first.id, scope)?.record.content).toBe('用户手动添加的重要限制必须原样保留')
  })

  it('retire archives without purging and only keeps five owned maintenance backup packs', () => {
    for (let i = 0; i < MEMORY_BACKUP_KEEP + 2; i++) {
      const record = insert({ content: `过时的约定内容需要留作历史回读 ${i}` })
      clock += 1
      organize({ merge: [], retire: [record.id] })
      expect(fixture.store.find(record.id, scope)?.record.status).toBe('retracted')
    }
    expect(readdirSync(join(dir, '.backups'))).toHaveLength(MEMORY_BACKUP_KEEP)
    writeFileSync(join(dir, '.backups', 'user-backup.md'), 'user data')
    fixture.store.trimMaintenanceBackups(scope)
    expect(readFileSync(join(dir, '.backups', 'user-backup.md'), 'utf8')).toBe('user data')
  })

  it('episodic month-end and legacy mtime TTLs, owned stale temps and links are checked', () => {
    const episodic = join(dir, 'episodic'); mkdirSync(episodic, { recursive: true })
    const end = new Date(2026, 6, 0, 23, 59, 59, 999).getTime()
    clock = end + 60 * day
    writeFileSync(join(episodic, '2026-06.md'), 'old operations')
    writeFileSync(join(episodic, 'legacy.md'), 'old legacy operations'); utimesSync(join(episodic, 'legacy.md'), new Date(end), new Date(end))
    const temp = join(dir, '.inbox.md.123.0000000000000000.tmp'); writeFileSync(temp, 'stale'); utimesSync(temp, new Date(clock - 3_600_001), new Date(clock - 3_600_001))
    expect(maintainMemoryFiles(dir, root, clock)).toBe(0)
    expect(existsSync(temp)).toBe(false)
    expect(maintainMemoryFiles(dir, root, clock + 1)).toBe(2)
    expect(readdirSync(episodic)).toEqual([])
    const outside = join(root, 'outside'); mkdirSync(outside); writeFileSync(join(outside, '2020-01.md'), 'external operations')
    rmSync(episodic, { recursive: true }); symlinkSync(outside, episodic, process.platform === 'win32' ? 'junction' : 'dir')
    expect(() => maintainMemoryFiles(dir, root, clock)).toThrow('Unsafe memory path')
    expect(readFileSync(join(outside, '2020-01.md'), 'utf8')).toBe('external operations')
  })

  it('epoch bump only removes extract observed/inferred, including inbox, and never clears manual/tool/verified records', () => {
    const extracted = insert({ status: 'pending', explicitness: 'observed' })
    const inferred = insert({ explicitness: 'inferred' })
    const protectedEntries = [insert({ explicitness: 'user_explicit', via: 'extract' }), insert({ explicitness: 'workspace_verified', via: 'extract' }), insert({ explicitness: 'observed', via: 'tool', status: 'pending' }), insert({ explicitness: 'inferred', via: 'user-edit' })]
    writeFileSync(join(root, '.migration.json'), JSON.stringify({ version: 1, markdownMigrated: true, learnedEpoch: 1, migratedAt: 1 }))
    const migrator = new LegacyMemoryMigrator(root)
    expect(migrator.upgradeLearnedEpoch(fixture.store, 1)).toBe(0)
    expect(migrator.upgradeLearnedEpoch(fixture.store, 2)).toBe(2)
    expect(fixture.store.find(extracted.id, scope)).toBeNull(); expect(fixture.store.find(inferred.id, scope)).toBeNull()
    expect(fixture.store.list(scope).map(entry => entry.record.id).sort()).toEqual(protectedEntries.map(entry => entry.id).sort())
    expect(JSON.parse(readFileSync(join(root, '.migration.json'), 'utf8'))).toEqual({ version: 1, markdownMigrated: true, learnedEpoch: 2, migratedAt: 1 })
    expect(migrator.upgradeLearnedEpoch(fixture.store, 2)).toBe(0)
  })
})
