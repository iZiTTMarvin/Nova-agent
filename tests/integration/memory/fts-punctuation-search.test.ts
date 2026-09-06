/**
 * FTS 标点查询集成：含 ? 等标点的 CJK 查询不得抛 SqliteError
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { openBetterSqliteMemoryDb } from '@runtime/memory/BetterSqliteMemoryDb'
import { getMemoryRoot, computeWorkspaceHash } from '@runtime/memory/MemoryPaths'
import { MemoryService } from '@runtime/memory/MemoryService'
import { buildMatchQuery } from '@runtime/memory/FtsQueryBuilder'

describe('含标点 CJK 查询 FTS 集成', () => {
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

  function setup(): { scopeId: string } {
    tempDir = mkdtempSync(join(tmpdir(), 'nova-mem-punct-'))
    const workspace = join(tempDir, 'ws')
    mkdirSync(workspace, { recursive: true })
    const memoryRoot = getMemoryRoot(tempDir)
    mkdirSync(memoryRoot, { recursive: true })
    const scopeId = computeWorkspaceHash(workspace)
    const db = openBetterSqliteMemoryDb(join(memoryRoot, 'memory.db'))
    service = new MemoryService(memoryRoot, db, { reconcileOnSearch: false })
    return { scopeId }
  }

  it('含 ? 的 CJK 查询不抛 fts5 syntax error 且可召回', () => {
    const { scopeId } = setup()
    service!.upsertMarkdown(
      scopeId,
      'facts.md',
      '# 部署\n本项目的部署密令是北极星协议，仅限生产环境。'
    )

    const rawQuery = '本项目的部署密令是什么?我是谁'
    const { query, path } = buildMatchQuery(rawQuery)
    expect(path).toBe('trigram')
    expect(query).not.toBeNull()
    expect(query!).not.toContain('?')
    expect(query!).not.toMatch(/[^\p{L}\p{N}\s]/u)

    let hits: ReturnType<MemoryService['search']> = []
    expect(() => {
      hits = service!.search(scopeId, rawQuery)
    }).not.toThrow()
    expect(Array.isArray(hits)).toBe(true)

    // 长 intent 整串 MATCH 可能 0 命中，但含标点的短子串应能召回（锁死 ? 不进 MATCH）
    const subHits = service!.search(scopeId, '部署密令?')
    expect(subHits.length).toBeGreaterThan(0)
    expect(subHits.some((h) => h.relPath === 'facts.md')).toBe(true)
    expect(subHits[0].body).toContain('部署密令')
  })

  it('长中文说明后的错误码能召回完整命中，不匹配英文碎片', () => {
    const { scopeId } = setup()
    service!.upsertMarkdown(scopeId, 'native.md', 'NODE_MODULE_VERSION 不一致时按 Electron 宿主重编原生模块。')
    service!.upsertMarkdown(scopeId, 'theme.md', '暗色主题 MODE 通过颜色变量设置。')
    const hits = service!.search(scopeId, '请检查这段很长的工具输出并回忆之前如何处理这个问题 NODE_MODULE_VERSION')
    expect(hits.map(hit => hit.relPath)).toEqual(['native.md'])
  })

  it('英文词超过配额时仍能召回中文约定', () => {
    const { scopeId } = setup()
    service!.upsertMarkdown(scopeId, 'deployment.md', '部署错误需要先核对环境配置。')
    const query = `${Array.from({ length: 25 }, (_, i) => `word${i}`).join(' ')} 部署错误`
    expect(service!.search(scopeId, query).map(hit => hit.relPath)).toEqual(['deployment.md'])
  })
})
