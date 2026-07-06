import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { MemoryDb, MemoryDbStatement } from '../../../../src/runtime/memory/MemoryDb'
import { MemoryService } from '../../../../src/runtime/memory/MemoryService'
import { getMemoryRoot, computeWorkspaceHash } from '../../../../src/runtime/memory/MemoryPaths'
import { mkdirSync } from 'fs'

/** 最小 MemoryDb mock：search 返回空，用于断言 reconcile 未被调用 */
function createNoopSearchDb(): MemoryDb {
  const emptyAll: MemoryDbStatement = {
    run: () => ({ changes: 0 }),
    get: () => undefined,
    all: () => []
  }
  return {
    sqliteVersion: '3.49.0',
    exec: vi.fn(),
    prepare: vi.fn(() => emptyAll),
    close: vi.fn()
  }
}

describe('MemoryService 索引行为（P1-A4 单测 mock）', () => {
  let tempDir: string
  let memoryRoot: string
  let scopeId: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'nova-mem-svc-idx-'))
    const workspace = join(tempDir, 'ws')
    mkdirSync(workspace, { recursive: true })
    memoryRoot = getMemoryRoot(tempDir)
    scopeId = computeWorkspaceHash(workspace)
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('search 默认不触发 reconcile（热路径只查索引）', () => {
    const db = createNoopSearchDb()
    const service = new MemoryService(memoryRoot, db, { reconcileOnSearch: false })
    const reconcileSpy = vi.spyOn(service, 'reconcile')

    service.search(scopeId, '足够长的查询词')

    expect(reconcileSpy).not.toHaveBeenCalled()
    service.close()
    expect(db.close).toHaveBeenCalled()
  })

  it('reconcileOnSearch=true 时 search 会先 reconcile', () => {
    const db = createNoopSearchDb()
    const service = new MemoryService(memoryRoot, db, { reconcileOnSearch: true })
    const reconcileSpy = vi
      .spyOn(service, 'reconcile')
      .mockReturnValue({ added: 0, updated: 0, removed: 0, skipped: 0 })

    service.search(scopeId, '足够长的查询词')

    expect(reconcileSpy).toHaveBeenCalledWith(scopeId)
    service.close()
  })

  it('无 db 时 search 返回空数组', () => {
    const service = new MemoryService(memoryRoot, null)
    expect(service.search(scopeId, 'query text')).toEqual([])
  })

  it('close 幂等', () => {
    const db = createNoopSearchDb()
    const service = new MemoryService(memoryRoot, db)
    service.close()
    service.close()
    expect(db.close).toHaveBeenCalledTimes(1)
  })
})
