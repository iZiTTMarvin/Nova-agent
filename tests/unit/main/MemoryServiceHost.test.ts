/**
 * MemoryServiceHost reconcile 调度：fire-and-forget、并发安全、memoryEnabled 门禁
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const hostEnvironment = vi.hoisted(() => ({ userData: '' }))

const reconcileMock = vi.fn()
const loadNovaSettingsMock = vi.fn()

vi.mock('electron', () => ({
  app: {
    getPath: () => hostEnvironment.userData
  }
}))

vi.mock('../../../src/runtime/memory/BetterSqliteMemoryDb', () => ({
  BetterSqliteMemoryDb: vi.fn(),
  openBetterSqliteMemoryDb: vi.fn(() => ({
    exec: vi.fn(),
    prepare: vi.fn(() => ({ get: () => undefined, all: () => [], run: () => ({ changes: 0 }) })),
    close: vi.fn(),
    sqliteVersion: '3.49.0'
  }))
}))

vi.mock('../../../src/main/services/SessionStoreHost', async () => {
  const { SessionStore } = await import('../../../src/runtime/sessions/SessionStore')
  let store: InstanceType<typeof SessionStore> | null = null
  const instance = () => (store ??= new SessionStore(hostEnvironment.userData))
  return {
    getSessionStore: instance,
    initSessionStoreHost: instance,
    resetSessionStoreHostForTests: () => { store = null }
  }
})

vi.mock('../../../src/runtime/memory/MemoryService', () => ({
  MemoryService: vi.fn().mockImplementation((_root, db) => ({
    reconcile: reconcileMock,
    registerWorkspace: vi.fn(),
    close: vi.fn(),
    hasIndex: () => db !== null
  }))
}))

vi.mock('../../../src/runtime/settings/novaSettings', () => ({
  loadNovaSettings: () => loadNovaSettingsMock()
}))

describe('MemoryServiceHost reconcile 调度', () => {
  beforeEach(() => {
    hostEnvironment.userData = mkdtempSync(join(tmpdir(), 'nova-memory-host-'))
    vi.clearAllMocks()
    loadNovaSettingsMock.mockReturnValue({
      memoryEnabled: true,
      memoryReconcileOnSearch: false,
      memorySearchLimit: 10,
      memoryScoreFloor: 0.15
    })
  })

  afterEach(async () => {
    const { resetMemoryServiceForTests } = await import(
      '../../../src/main/services/MemoryServiceHost'
    )
    resetMemoryServiceForTests()
    rmSync(hostEnvironment.userData, { recursive: true, force: true })
  })

  it('scheduleMemoryScopeReconcile 为 fire-and-forget，同步返回不阻塞', async () => {
    const { scheduleMemoryScopeReconcile } = await import(
      '../../../src/main/services/MemoryServiceHost'
    )
    scheduleMemoryScopeReconcile('scope-a')
    expect(reconcileMock).not.toHaveBeenCalled()

    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(reconcileMock).toHaveBeenCalledTimes(1)
    expect(reconcileMock).toHaveBeenCalledWith('scope-a')
  })

  it('同一 scope 不重复 reconcile', async () => {
    const { scheduleMemoryScopeReconcile } = await import(
      '../../../src/main/services/MemoryServiceHost'
    )
    scheduleMemoryScopeReconcile('scope-b')
    scheduleMemoryScopeReconcile('scope-b')
    scheduleMemoryScopeReconcile('scope-b')

    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(reconcileMock).toHaveBeenCalledTimes(1)
  })

  it('memoryEnabled:false 时跳过 reconcile', async () => {
    loadNovaSettingsMock.mockReturnValue({
      memoryEnabled: false,
      memoryReconcileOnSearch: false,
      memorySearchLimit: 10,
      memoryScoreFloor: 0.15
    })
    const { scheduleMemoryScopeReconcile } = await import(
      '../../../src/main/services/MemoryServiceHost'
    )
    scheduleMemoryScopeReconcile('scope-off')
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(reconcileMock).not.toHaveBeenCalled()
  })

  it('原生绑定缺失时保留文件读写和降级检索，并提供可行动诊断', async () => {
    const { openBetterSqliteMemoryDb } = await import(
      '../../../src/runtime/memory/BetterSqliteMemoryDb'
    )
    vi.mocked(openBetterSqliteMemoryDb).mockImplementationOnce(() => {
      throw new Error('Could not locate the bindings file')
    })
    const { getMemoryService, getMemoryRepository, getMemoryIndexDiagnostic } = await import(
      '../../../src/main/services/MemoryServiceHost'
    )
    expect(() => getMemoryService()).not.toThrow()
    expect(getMemoryService().hasIndex()).toBe(false)
    expect(getMemoryIndexDiagnostic()).toContain('rebuild:native:electron')
    const repo = getMemoryRepository()
    repo.insertRecord({ id: 'm_0000000001', scope: { scopeKind: 'global', scopeId: 'user' }, kind: 'preference', memoryKey: 'reply.language', content: '用户要求中文回答', status: 'active', explicitness: 'user_explicit', confidence: 1, sourceType: 'user_message' })
    expect(repo.searchFts('中文')[0].record.id).toBe('m_0000000001')
    expect(repo.purge('m_0000000001')).toBe(true)
  })

  it('结构化仓储、候选处理器与检索层随服务单例装配，close 后一并释放', async () => {
    const {
      getMemoryService,
      getMemoryRepository,
      getMemoryCandidateProcessor,
      getMemoryRetrievalService,
    } = await import('../../../src/main/services/MemoryServiceHost')
    getMemoryService()
    const repo = getMemoryRepository()
    const processor = getMemoryCandidateProcessor()
    const retrieval = getMemoryRetrievalService()
    expect(getMemoryRepository()).toBe(repo)
    expect(getMemoryCandidateProcessor()).toBe(processor)
    expect(getMemoryRetrievalService()).toBe(retrieval)

    const { resetMemoryServiceForTests } = await import(
      '../../../src/main/services/MemoryServiceHost'
    )
    resetMemoryServiceForTests()
    getMemoryService()
    expect(getMemoryRepository()).not.toBe(repo)
    expect(getMemoryCandidateProcessor()).not.toBe(processor)
    expect(getMemoryRetrievalService()).not.toBe(retrieval)
  })

  it('an unavailable legacy database preserves read access and rejects managed writes', async () => {
    const root = join(hostEnvironment.userData, 'memory')
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'memory.db'), 'unavailable legacy database')
    const { openBetterSqliteMemoryDb } = await import('../../../src/runtime/memory/BetterSqliteMemoryDb')
    vi.mocked(openBetterSqliteMemoryDb).mockImplementationOnce(() => { throw new Error('binding unavailable') })
    const { getMemoryEntryStore, getMemoryIndexDiagnostic } = await import('../../../src/main/services/MemoryServiceHost')
    const store = getMemoryEntryStore()
    expect(store.isReadOnly()).toBe(true)
    expect(getMemoryIndexDiagnostic()).toContain('仅可读取')
    expect(store.list({ scopeKind: 'global', scopeId: 'user' })).toEqual([])
    expect(() => store.insert({ id: 'm_0000000001', scope: { scopeKind: 'global', scopeId: 'user' }, kind: 'preference', content: '中文回答', status: 'active', explicitness: 'user_explicit', confidence: 1, sourceType: 'user_message' })).toThrow('read-only')
  })

  it('a corrupt migration marker cannot bypass read-only degradation', async () => {
    const root = join(hostEnvironment.userData, 'memory')
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, '.migration.json'), '{ broken marker')
    const { getMemoryEntryStore, getMemoryIndexDiagnostic } = await import('../../../src/main/services/MemoryServiceHost')
    expect(getMemoryEntryStore().isReadOnly()).toBe(true)
    expect(getMemoryIndexDiagnostic()).toContain('仅可读取')
  })
})
