/**
 * FTS 检索与 reconcile 集成（better-sqlite3 @ Node ABI）
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { openBetterSqliteMemoryDb } from '@runtime/memory/BetterSqliteMemoryDb'
import { getMemoryRoot, computeWorkspaceHash, getProjectMemoryDir } from '@runtime/memory/MemoryPaths'
import { MemoryService } from '@runtime/memory/MemoryService'

describe('MemoryService FTS 集成', () => {
  let tempDir: string | null = null
  let service: MemoryService | null = null

  afterEach(() => {
    service?.close()
    service = null
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true })
      tempDir = null
    }
  })

  function setup(): { scopeId: string; memoryRoot: string } {
    tempDir = mkdtempSync(join(tmpdir(), 'nova-mem-search-'))
    const workspace = join(tempDir, 'ws')
    mkdirSync(workspace, { recursive: true })
    const memoryRoot = getMemoryRoot(tempDir)
    mkdirSync(memoryRoot, { recursive: true })
    const scopeId = computeWorkspaceHash(workspace)
    const db = openBetterSqliteMemoryDb(join(memoryRoot, 'memory.db'))
    service = new MemoryService(memoryRoot, db, { reconcileOnSearch: false })
    return { scopeId, memoryRoot }
  }

  it('中文两字词召回普通文档，托管视图不进入文档索引', () => {
    const { scopeId } = setup()
    service!.upsertMarkdown(
      scopeId,
      'notes.md',
      '# 偏好\n用户要求注释一律使用中文。'
    )
    service!.upsertMarkdown(scopeId, 'MEMORY.md', '使用中文')
    const hits = service!.search(scopeId, '中文')
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0].relPath).toBe('notes.md')
    expect(hits.every(hit => hit.relPath !== 'MEMORY.md')).toBe(true)
  })

  it('英文 query unicode61 风格 OR 路径可召回', () => {
    const { scopeId } = setup()
    service!.upsertMarkdown(
      scopeId,
      'notes/api.md',
      '# API\nUse REST endpoints for authentication and authorization.'
    )
    const hits = service!.search(scopeId, 'authentication authorization')
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0].body.toLowerCase()).toContain('authentication')
  })

  it('reconcile 同步磁盘新增/修改/删除', () => {
    const { scopeId, memoryRoot } = setup()
    const scopeDir = getProjectMemoryDir(memoryRoot, scopeId)
    mkdirSync(scopeDir, { recursive: true })
    writeFileSync(join(scopeDir, 'a.md'), 'version one', 'utf8')

    const first = service!.reconcile(scopeId)
    expect(first.added).toBe(1)

    writeFileSync(join(scopeDir, 'a.md'), 'version two', 'utf8')
    writeFileSync(join(scopeDir, 'b.md'), 'new file', 'utf8')
    const second = service!.reconcile(scopeId)
    expect(second.updated).toBe(1)
    expect(second.added).toBe(1)

    const hits = service!.search(scopeId, 'version')
    expect(hits.some((h) => h.relPath === 'a.md')).toBe(true)

    rmSync(join(scopeDir, 'b.md'))
    const third = service!.reconcile(scopeId)
    expect(third.removed).toBe(1)
  })

  it('查询无匹配词项时返回空，短词按新分词契约检索', () => {
    const { scopeId } = setup()
    service!.upsertMarkdown(scopeId, 'notes.md', 'hello world content ab')
    expect(service!.search(scopeId, 'xy')).toEqual([])
    expect(service!.search(scopeId, 'ab')[0].relPath).toBe('notes.md')
  })
})
