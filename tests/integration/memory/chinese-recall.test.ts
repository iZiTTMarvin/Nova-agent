/**
 * P1-B5 关键回归：中文 MEMORY.md + extractUserIntent 长串 query → trigram 召回（集成层）
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { openBetterSqliteMemoryDb } from '@runtime/memory/BetterSqliteMemoryDb'
import { getMemoryRoot, computeWorkspaceHash } from '@runtime/memory/MemoryPaths'
import { MemoryService } from '@runtime/memory/MemoryService'
import { extractUserIntent, buildSearchQueryFromIntent, buildL2TailBlock } from '@runtime/memory/MemoryTailInjector'

describe('中文记忆召回（P1-B5 集成）', () => {
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
    tempDir = mkdtempSync(join(tmpdir(), 'nova-mem-cn-'))
    const workspace = join(tempDir, 'ws')
    mkdirSync(workspace, { recursive: true })
    const memoryRoot = getMemoryRoot(tempDir)
    mkdirSync(memoryRoot, { recursive: true })
    const scopeId = computeWorkspaceHash(workspace)
    const db = openBetterSqliteMemoryDb(join(memoryRoot, 'memory.db'))
    service = new MemoryService(memoryRoot, db, { reconcileOnSearch: false })
    return { scopeId }
  }

  it('extractUserIntent 拼接串 + 中文子串 query 命中 MEMORY.md', () => {
    const { scopeId } = setup()
    service!.upsertMarkdown(
      scopeId,
      'MEMORY.md',
      [
        '# 编码偏好',
        '',
        '前言 ' + 'x'.repeat(200),
        '用户要求继续用中文写注释，变量名仍用英文。',
        '后记 ' + 'y'.repeat(200)
      ].join('\n')
    )

    const query = extractUserIntent({
      sessionTitle: 'Nova 项目',
      recentUserMessages: ['上次说过注释语言的事'],
      currentUserText: '继续用中文写注释'
    })
    const searchQuery = buildSearchQueryFromIntent(query)

    const hits = service!.search(scopeId, searchQuery)
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0].relPath).toBe('MEMORY.md')

    const l2 = buildL2TailBlock(hits, query)
    expect(l2).toContain('用中文')
    expect(l2).toContain('[MEMORY.md]')
  })

  it('直接中文子串 query 可召回', () => {
    const { scopeId } = setup()
    service!.upsertMarkdown(
      scopeId,
      'MEMORY.md',
      '团队约定：PR 描述必须写中文摘要。'
    )
    const hits = service!.search(scopeId, '中文摘要')
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0].body).toContain('中文摘要')
  })
})
