import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { IpcMainInvokeEvent } from 'electron'
import { MemoryEntryStore } from '../../../src/runtime/memory/markdown/MemoryEntryStore'
import { MemoryForgetter } from '../../../src/runtime/memory/forget/MemoryForgetter'
import { MemoryService } from '../../../src/runtime/memory/MemoryService'
import { GLOBAL_SCOPE_ID } from '../../../src/runtime/memory/MemoryPaths'
import { MEMORY_FILE_HEADER, generateMemoryEntryId } from '../../../src/runtime/memory/markdown/entryFormat'
import { renderMemorySnapshot } from '../../../src/runtime/memory/snapshot/renderMemorySnapshot'
import type { MemoryEntryDto } from '../../../src/shared/memory/types'
const registrations = vi.fn(), mainFrame = {}, webContents = { mainFrame }, window = { webContents }
let root: string, workspace: string | null, store: MemoryEntryStore, service: MemoryService, scopeId: string
vi.mock('electron', () => ({ shell: { openPath: async () => '' }, ipcMain: { handle: (...args: unknown[]) => registrations(...args) }, app: { getPath: () => root } }))
vi.mock('../../../src/main/mainWindowRef', () => ({ getMainWindow: () => window }))
vi.mock('../../../src/main/services/WorkspaceService', () => ({ getWorkspaceService: () => ({ getState: () => ({ currentProjectPath: workspace }) }) }))
vi.mock('../../../src/main/services/MemoryMaintenanceHost', () => ({ organizeMemoryTopic: async () => ({ merged: 0, retired: 0 }) }))
vi.mock('../../../src/main/services/MemoryServiceHost', () => ({
  getMemoryService: () => service, getMemoryEntryStore: () => store, getMemoryIndexDiagnostic: () => null, getMemoryIndexStatus: () => 'ok',
  getMemoryForgetter: () => new MemoryForgetter({ store, copies: [], index: null }),
  captureMemorySnapshot: () => renderMemorySnapshot({ capturedAt: Date.now(), global: store.snapshotScope({ scopeKind: 'global', scopeId: GLOBAL_SCOPE_ID }), project: store.snapshotScope({ scopeKind: 'project', scopeId }) }),
  listUnclaimedMemory: () => [], deleteUnclaimedMemory: () => undefined
}))
import { registerMemoryHandler } from '../../../src/main/ipc/memoryHandler'
function call(channel: string, params?: unknown): Promise<unknown> {
  const registration = registrations.mock.calls.find(row => row[0] === channel)
  if (!registration) throw new Error(`Missing handler ${channel}`)
  const handler = registration[1] as (event: IpcMainInvokeEvent, params: unknown) => Promise<unknown>
  return handler({ sender: webContents, senderFrame: mainFrame } as unknown as IpcMainInvokeEvent, params)
}
function insert(global = false, pending = false) {
  return store.insert({ id: generateMemoryEntryId(), scope: { scopeKind: global ? 'global' : 'project', scopeId: global ? GLOBAL_SCOPE_ID : scopeId }, kind: 'convention', memoryKey: null, content: '提交信息使用中文并说明必要原因', status: pending ? 'pending' : 'active', confidence: .8, explicitness: 'observed', sourceType: 'user_message', evidence: [{ evidenceType: 'user_message', excerpt: '提交信息使用中文并说明必要原因' }] })
}
beforeEach(() => {
  registrations.mockClear(); root = mkdtempSync(join(tmpdir(), 'nova-memory-ipc-')); workspace = join(root, 'workspace')
  store = new MemoryEntryStore(root); service = new MemoryService(root, null, { entryStore: store })
  scopeId = store.registerWorkspace(workspace); service.registerWorkspace(workspace); registerMemoryHandler()
})
afterEach(() => { service.close(); rmSync(root, { recursive: true, force: true }) })
describe('Markdown memory IPC', () => {
  it('lists file-derived DTOs without evidence text or internal fingerprints, including locations', async () => {
    const active = insert(), pending = insert(false, true)
    const rows = await call('memory:list-entries', { scopeKind: 'project' }) as MemoryEntryDto[]
    expect(rows.map(row => row.id)).toEqual([active.id, pending.id])
    expect(rows[0]).toMatchObject({ relPath: 'conventions.md', location: 'topics', text: active.content, evidenceCount: 1, pinned: false })
    expect(Object.keys(rows[0]).sort()).toEqual(['addedDate', 'aliases', 'evidenceCount', 'explicitness', 'id', 'key', 'kind', 'lastSeenAt', 'location', 'needsVerification', 'pinned', 'relPath', 'scopeKind', 'text'].sort())
    expect(await call('memory:list-entries', { scopeKind: 'project', location: 'inbox' })).toMatchObject([{ id: pending.id }])
  })
  it('rejects cross-project scopes, invalid parameters, and project access without workspace', async () => {
    await expect(call('memory:list-entries', { scopeKind: 'project', scopeId: 'deadbeefdeadbeef' })).rejects.toThrow('无权访问其他项目')
    for (const params of [null, { scopeKind: 'workspace' }, { scopeKind: 123 }, { scopeKind: 'project', location: 'bogus' }]) await expect(call('memory:list-entries', params)).rejects.toThrow()
    workspace = null; await expect(call('memory:list-entries', { scopeKind: 'project' })).rejects.toThrow('请先打开工作区')
  })
  it('allows all permitted global kinds without a workspace and verifies global scope ID', async () => {
    const global = insert(true); workspace = null
    expect(await call('memory:list-entries', { scopeKind: 'global' })).toMatchObject([{ id: global.id, kind: 'convention' }])
    expect(await call('memory:list-files', { scopeKind: 'global' })).toMatchObject([{ relPath: 'conventions.md', managed: true, readOnly: false }, { relPath: 'MEMORY.md', managed: true, readOnly: true }])
    await expect(call('memory:list-entries', { scopeKind: 'global', scopeId })).rejects.toThrow('无权访问')
  })
  it('complete forget removes topic, ledger, generated view and repository projection; missing IDs fail', async () => {
    const record = insert()
    await call('memory:forget-entry', { scopeKind: 'project', id: record.id })
    expect(store.find(record.id)).toBeNull()
    expect(await call('memory:list-entries', { scopeKind: 'project' })).toEqual([])
    const dir = service.stats(scopeId).scopeDir
    for (const path of ['conventions.md', '.ledger.jsonl', 'MEMORY.md']) expect(readFileSync(join(dir, path), 'utf8')).not.toContain(record.id)
    expect(readFileSync(join(dir, 'MEMORY.md'), 'utf8')).not.toContain(record.content)
    await expect(call('memory:forget-entry', { scopeKind: 'project', id: record.id })).rejects.toThrow('不存在')
  })
  it('refuses forgetting or pinning entries from another scope and validates boolean pin', async () => {
    const record = insert(true)
    for (const channel of ['memory:forget-entry', 'memory:set-entry-pinned', 'memory:decide-inbox']) await expect(call(channel, { scopeKind: 'project', id: record.id, pinned: true, decision: 'reject' })).rejects.toThrow('无权操作其他范围')
    await expect(call('memory:set-entry-pinned', { scopeKind: 'global', id: record.id, pinned: 1 })).rejects.toThrow('布尔')
    await expect(call('memory:forget-entry', { scopeKind: 'global', id: ' ' })).rejects.toThrow('缺少')
    expect(store.find(record.id)?.pinned).toBe(false)
  })
  it('pin changes the file and preview, and inbox approve promotes by=user while reject purges', async () => {
    const record = insert(), pending = insert(false, true), rejected = insert(false, true)
    await call('memory:set-entry-pinned', { scopeKind: 'project', id: record.id, pinned: true })
    expect(store.find(record.id)?.pinned).toBe(true)
    expect(await call('memory:snapshot-preview')).toMatchObject({ projectCoreCount: 1 })
    await call('memory:decide-inbox', { scopeKind: 'project', id: pending.id, decision: 'approve' })
    expect(store.find(pending.id)?.record).toMatchObject({ explicitness: 'user_explicit', status: 'active' })
    await call('memory:decide-inbox', { scopeKind: 'project', id: rejected.id, decision: 'reject' })
    expect(store.find(rejected.id)).toBeNull()
    await expect(call('memory:decide-inbox', { scopeKind: 'project', id: record.id, decision: 'approve' })).rejects.toThrow('不在 inbox')
  })
  it('managed writes assign manual IDs, synchronize facts and report parse issues; generated/private files are rejected', async () => {
    for (const relPath of ['MEMORY.md', 'memory.md', '.ledger.md', 'sub/.hidden.md']) await expect(call('memory:write-file', { scopeKind: 'project', relPath, content: 'overwrite' })).rejects.toThrow('只读')
    expect(await call('memory:write-file', { scopeKind: 'project', relPath: 'conventions.md', content: `${MEMORY_FILE_HEADER}\n# Conventions\n- 手动填写的记忆应进入同一文件事实源\n- broken <!-- invalid -->\n` })).toEqual({ parseIssues: 1 })
    const entries = store.list({ scopeKind: 'project', scopeId })
    expect(entries).toHaveLength(1); expect(entries[0].record.explicitness).toBe('user_explicit')
    expect(service.readScopeFile(scopeId, 'MEMORY.md')).toContain('手动填写的记忆')
    store.setReadOnly(true)
    await expect(call('memory:write-file', { scopeKind: 'project', relPath: 'notes.md', content: 'notes' })).rejects.toThrow('read-only')
  })
  it('future format remains read-only and file metadata reports it', async () => {
    service.upsertMarkdown(scopeId, 'conventions.md', '<!-- nova-memory v99 -->\n- future data\n')
    expect(await call('memory:list-files', { scopeKind: 'project' })).toMatchObject([{ relPath: 'conventions.md', readOnly: true }, { relPath: 'MEMORY.md', readOnly: true }])
    await expect(call('memory:write-file', { scopeKind: 'project', relPath: 'conventions.md', content: MEMORY_FILE_HEADER })).rejects.toThrow('read-only')
  })
  it('stats include positions and malformed ledger diagnostics; removed record channels are not registered', async () => {
    insert(); insert(false, true)
    expect(await call('memory:stats')).toMatchObject({ entries: { topics: 1, inbox: 1, archive: 0 }, indexStatus: 'ok', ledgerBadLines: 0 })
    const ledger = join(service.stats(scopeId).scopeDir, '.ledger.jsonl')
    appendFileSync(ledger, 'malformed raw provenance\n')
    expect(await call('memory:stats')).toMatchObject({ ledgerBadLines: 1 })
    expect(readFileSync(ledger, 'utf8')).toContain('malformed raw provenance')
    expect(registrations.mock.calls.map(row => row[0])).not.toContain('memory:list-records')
    expect(registrations.mock.calls.map(row => row[0])).not.toContain('memory:retract-record')
  })
})
