/**
 * 结构化记忆管理 IPC（memory:list-records / memory:retract-record / memory:stats）
 *
 * mock 掉 electron / MemoryServiceHost / WorkspaceService / 主窗口引用，
 * 捕获 secureIpc 注册的监听函数直接调用，断言：
 * - project scope 只允许当前工作区（scopeId 由主进程解析，越权传入被拒）
 * - 非法 scopeKind / status 被拒；默认只列 active
 * - retract 校验记录归属后才执行；忘记后默认列表不再返回
 * - stats 追加结构化记录按状态计数
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import { computeWorkspaceHash, GLOBAL_SCOPE_ID } from '../../../src/runtime/memory/MemoryPaths'
import type { MemoryRecord } from '../../../src/runtime/memory/types'
import type { MemoryRecordDto } from '../../../src/shared/memory/types'

const mockHandle = vi.fn()

// 主窗口主 frame 伪造链：secureIpc 要求 event.sender === mainWindow.webContents
const fakeMainFrame = {}
const fakeWebContents = { mainFrame: fakeMainFrame }
const fakeWindow = { webContents: fakeWebContents }

function makeTrustedEvent(): IpcMainInvokeEvent {
  return { sender: fakeWebContents, senderFrame: fakeMainFrame } as unknown as IpcMainInvokeEvent
}

// ── 工作区状态 mock：currentProjectPath 可在用例间切换 ──
let currentProjectPath: string | null = '/tmp/project-a'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/nova-test' },
  shell: { openPath: vi.fn(async () => '') },
  ipcMain: { handle: (...args: unknown[]) => mockHandle(...args) }
}))

vi.mock('fs', () => ({
  mkdirSync: vi.fn()
}))

vi.mock('../../../src/main/mainWindowRef', () => ({
  getMainWindow: () => fakeWindow
}))

vi.mock('../../../src/main/services/WorkspaceService', () => ({
  getWorkspaceService: () => ({
    getState: () => ({ currentProjectPath })
  })
}))

// ── 内存 fake 仓储：行为对齐 SqliteMemoryRepository 的语义（按 scope/status 过滤、retract 标记） ──
function makeRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: 'mem_1',
    scopeKind: 'project',
    scopeId: computeWorkspaceHash('/tmp/project-a'),
    kind: 'decision',
    memoryKey: 'database.primary',
    content: '项目当前主要数据库为 PostgreSQL',
    status: 'active',
    confidence: 0.9,
    explicitness: 'workspace_verified',
    sourceType: 'workspace',
    validFrom: 1,
    validTo: null,
    supersedesId: null,
    evidenceCount: 2,
    distinctSessionCount: 1,
    distinctProjectCount: 1,
    sourcePath: 'package.json',
    sourceFingerprint: null,
    createdAt: 1,
    updatedAt: 2,
    lastSeenAt: 2,
    metadata: null,
    ...overrides
  }
}

let records: MemoryRecord[] = []

const fakeRepository = {
  listByScope: vi.fn((scope: { scopeKind: string; scopeId: string }, options?: { status?: string }) => {
    const status = options?.status
    return records.filter(
      r =>
        r.scopeKind === scope.scopeKind &&
        r.scopeId === scope.scopeId &&
        (status === undefined || r.status === status)
    )
  }),
  findById: vi.fn((id: string) => records.find(r => r.id === id) ?? null),
  retract: vi.fn((id: string) => {
    const record = records.find(r => r.id === id)
    if (!record) return false
    record.status = 'retracted'
    return true
  }),
  stats: vi.fn((scope?: { scopeKind: string; scopeId: string }) => {
    const filtered = scope
      ? records.filter(r => r.scopeKind === scope.scopeKind && r.scopeId === scope.scopeId)
      : records
    const grouped = new Map<string, { scopeKind: string; scopeId: string; kind: string; status: string; count: number }>()
    for (const r of filtered) {
      const key = `${r.scopeKind}:${r.scopeId}:${r.kind}:${r.status}`
      const row = grouped.get(key)
      if (row) {
        row.count += 1
      } else {
        grouped.set(key, { scopeKind: r.scopeKind, scopeId: r.scopeId, kind: r.kind, status: r.status, count: 1 })
      }
    }
    return [...grouped.values()]
  })
}

const fakeMemoryService = {
  stats: vi.fn((scopeId: string) => ({
    scopeId,
    scopeDir: `/tmp/nova-test/memory/${scopeId}`,
    fileCount: 3,
    indexCount: 3,
    diskBytes: 1234
  }))
}

vi.mock('../../../src/main/services/MemoryServiceHost', () => ({
  getMemoryService: () => fakeMemoryService,
  getMemoryRepository: () => fakeRepository
}))

import { registerMemoryHandler } from '../../../src/main/ipc/memoryHandler'

type HandlerFn = (event: IpcMainInvokeEvent, params: unknown) => Promise<unknown>

function registeredHandler(channel: string): HandlerFn {
  const call = mockHandle.mock.calls.find(c => c[0] === channel)
  if (!call) throw new Error(`channel ${channel} 未注册`)
  return call[1] as HandlerFn
}

describe('memoryHandler 结构化记忆管理 IPC', () => {
  beforeEach(() => {
    mockHandle.mockClear()
    vi.clearAllMocks()
    currentProjectPath = '/tmp/project-a'
    records = [makeRecord()]
    registerMemoryHandler()
  })

  describe('memory:list-records', () => {
    it('project scope：由主进程按当前工作区解析 scopeId，返回 DTO（无 evidence 全文）', async () => {
      const handler = registeredHandler('memory:list-records')
      const result = (await handler(makeTrustedEvent(), { scopeKind: 'project' })) as MemoryRecordDto[]

      expect(fakeRepository.listByScope).toHaveBeenCalledWith(
        { scopeKind: 'project', scopeId: computeWorkspaceHash('/tmp/project-a') },
        { status: 'active' }
      )
      expect(result).toHaveLength(1)
      expect(result[0]).toEqual({
        id: 'mem_1',
        scopeKind: 'project',
        kind: 'decision',
        memoryKey: 'database.primary',
        content: '项目当前主要数据库为 PostgreSQL',
        status: 'active',
        explicitness: 'workspace_verified',
        evidenceCount: 2,
        sourceSummary: 'package.json',
        createdAt: 1,
        updatedAt: 2
      })
      // DTO 不泄漏内部字段
      expect(Object.keys(result[0])).not.toContain('sourceFingerprint')
      expect(Object.keys(result[0])).not.toContain('metadata')
    })

    it('renderer 传入他人项目 scopeId 时被拒', async () => {
      const handler = registeredHandler('memory:list-records')
      await expect(
        handler(makeTrustedEvent(), { scopeKind: 'project', scopeId: 'deadbeefdeadbeef' })
      ).rejects.toThrow(/无权访问其他项目/)
      expect(fakeRepository.listByScope).not.toHaveBeenCalled()
    })

    it('未打开工作区时 project scope 报可理解错误', async () => {
      currentProjectPath = null
      const handler = registeredHandler('memory:list-records')
      await expect(handler(makeTrustedEvent(), { scopeKind: 'project' })).rejects.toThrow(
        /请先打开工作区项目/
      )
    })

    it('global scope：固定 user scopeId，无需工作区', async () => {
      currentProjectPath = null
      records = [makeRecord({ id: 'mem_g', scopeKind: 'global', scopeId: GLOBAL_SCOPE_ID, kind: 'preference' })]
      const handler = registeredHandler('memory:list-records')
      const result = (await handler(makeTrustedEvent(), { scopeKind: 'global' })) as MemoryRecordDto[]
      expect(fakeRepository.listByScope).toHaveBeenCalledWith(
        { scopeKind: 'global', scopeId: GLOBAL_SCOPE_ID },
        { status: 'active' }
      )
      expect(result.map(r => r.id)).toEqual(['mem_g'])
    })

    it('非法 scopeKind / status 被拒', async () => {
      const handler = registeredHandler('memory:list-records')
      await expect(handler(makeTrustedEvent(), { scopeKind: 'workspace' })).rejects.toThrow(/scopeKind/)
      await expect(handler(makeTrustedEvent(), { scopeKind: 123 })).rejects.toThrow(/scopeKind/)
      await expect(
        handler(makeTrustedEvent(), { scopeKind: 'project', status: 'bogus' })
      ).rejects.toThrow(/status/)
    })

    it('默认只返回 active；retract 后的记录从默认列表消失', async () => {
      const handler = registeredHandler('memory:list-records')
      const retract = registeredHandler('memory:retract-record')

      const before = (await handler(makeTrustedEvent(), { scopeKind: 'project' })) as MemoryRecordDto[]
      expect(before.map(r => r.id)).toEqual(['mem_1'])

      await retract(makeTrustedEvent(), { id: 'mem_1', scopeKind: 'project' })

      const after = (await handler(makeTrustedEvent(), { scopeKind: 'project' })) as MemoryRecordDto[]
      expect(after).toEqual([])
    })
  })

  describe('memory:retract-record', () => {
    it('归属校验通过时标记 retracted', async () => {
      const handler = registeredHandler('memory:retract-record')
      await handler(makeTrustedEvent(), { id: 'mem_1', scopeKind: 'project' })
      expect(fakeRepository.retract).toHaveBeenCalledWith('mem_1')
      expect(records[0].status).toBe('retracted')
    })

    it('记录不存在时报可理解错误', async () => {
      const handler = registeredHandler('memory:retract-record')
      await expect(
        handler(makeTrustedEvent(), { id: 'mem_missing', scopeKind: 'project' })
      ).rejects.toThrow(/不存在/)
      expect(fakeRepository.retract).not.toHaveBeenCalled()
    })

    it('记录属于其他项目 scope 时拒绝操作', async () => {
      records = [makeRecord({ id: 'mem_other', scopeId: computeWorkspaceHash('/tmp/project-b') })]
      const handler = registeredHandler('memory:retract-record')
      await expect(
        handler(makeTrustedEvent(), { id: 'mem_other', scopeKind: 'project' })
      ).rejects.toThrow(/无权操作其他范围/)
      expect(fakeRepository.retract).not.toHaveBeenCalled()
    })

    it('声明 global 但记录属于 project scope 时拒绝操作', async () => {
      const handler = registeredHandler('memory:retract-record')
      await expect(
        handler(makeTrustedEvent(), { id: 'mem_1', scopeKind: 'global' })
      ).rejects.toThrow(/无权操作其他范围/)
      expect(fakeRepository.retract).not.toHaveBeenCalled()
    })

    it('缺少 id 时报错', async () => {
      const handler = registeredHandler('memory:retract-record')
      await expect(handler(makeTrustedEvent(), { id: '  ', scopeKind: 'project' })).rejects.toThrow(
        /缺少记忆记录 id/
      )
    })
  })

  describe('memory:stats', () => {
    it('保留文档统计并追加结构化记录按状态计数', async () => {
      records = [
        makeRecord(),
        makeRecord({ id: 'mem_2', status: 'pending', memoryKey: null }),
        makeRecord({ id: 'mem_3', status: 'retracted' })
      ]
      const handler = registeredHandler('memory:stats')
      const stats = (await handler(makeTrustedEvent(), undefined)) as {
        fileCount: number
        records: { active: number; pending: number; superseded: number; retracted: number; needsVerification: number }
      }

      expect(stats.fileCount).toBe(3)
      expect(stats.records).toEqual({
        active: 1,
        pending: 1,
        superseded: 0,
        retracted: 1,
        needsVerification: 0
      })
    })
  })
})
