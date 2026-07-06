/**
 * P1-A2/A4：FTS 检索与 reconcile 集成（better-sqlite3 @ Node ABI）
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { openBetterSqliteMemoryDb } from '@runtime/memory/BetterSqliteMemoryDb'
import { getMemoryRoot, computeWorkspaceHash } from '@runtime/memory/MemoryPaths'
import { MemoryService } from '@runtime/memory/MemoryService'

describe('MemoryService FTS 集成（P1-A2/A4）', () => {
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

  it('中文 query trigram 召回 MEMORY.md', () => {
    const { scopeId } = setup()
    service!.upsertMarkdown(
      scopeId,
      'MEMORY.md',
      '# 偏好\n用户要求注释一律使用中文。'
    )
    const hits = service!.search(scopeId, '使用中文')
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0].relPath).toBe('MEMORY.md')
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
    const scopeDir = join(memoryRoot, scopeId)
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

  it('query 不足 3 字符返回空（由 L1 兜底）', () => {
    const { scopeId } = setup()
    service!.upsertMarkdown(scopeId, 'MEMORY.md', 'hello world content')
    expect(service!.search(scopeId, 'ab')).toEqual([])
  })
})
