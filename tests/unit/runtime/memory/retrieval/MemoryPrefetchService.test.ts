/**
 * prefetch 注入块构建测试：格式契约（标题/分组/Rules 三行）、预算截断与空结果降级。
 * 保护契约：无高相关记忆返回 null 绝不输出空块；单条 structured ≤320；分组条数上限；advisory 标注。
 */
import { describe, it, expect } from 'vitest'
import { MemoryPrefetchService } from '../../../../../src/runtime/memory/retrieval/MemoryPrefetchService'
import {
  MEMORY_PREFETCH_GLOBAL_MAX_ITEMS,
  MEMORY_PREFETCH_PROJECT_STRUCTURED_MAX_ITEMS,
  MEMORY_PREFETCH_DOCUMENT_MAX_ITEMS,
  MEMORY_PREFETCH_STRUCTURED_MAX_CHARS,
  MEMORY_PREFETCH_TOTAL_MAX_CHARS
} from '../../../../../src/runtime/memory/MemoryBudget'
import type {
  DocumentMemoryResult,
  MemorySearchInput,
  MemorySearchResult,
  StructuredMemoryResult
} from '../../../../../src/runtime/memory/retrieval/MemoryRetriever'

function structured(overrides: Partial<StructuredMemoryResult> = {}): StructuredMemoryResult {
  return {
    id: 'mem_x',
    group: 'structured-project',
    kind: 'decision',
    content: '决定使用 PostgreSQL',
    status: 'active',
    explicitness: 'workspace_verified',
    confidence: 0.9,
    memoryKey: 'db',
    lastSeenAt: 0,
    advisory: false,
    historicalNote: null,
    source: null,
    ...overrides
  }
}

function documentResult(overrides: Partial<DocumentMemoryResult> = {}): DocumentMemoryResult {
  return {
    id: 'MEMORY.md',
    group: 'document',
    kind: 'document',
    relPath: 'MEMORY.md',
    body: '# 项目记忆\n部署使用 pnpm。',
    advisory: false,
    historicalNote: null,
    ...overrides
  }
}

function createService(results: MemorySearchResult[], capture?: (input: MemorySearchInput) => void) {
  const search = async (input: MemorySearchInput): Promise<MemorySearchResult[]> => {
    capture?.(input)
    return results
  }
  return new MemoryPrefetchService({ search })
}

describe('MemoryPrefetchService', () => {
  it('无结果时返回 null，绝不输出空块', async () => {
    const service = createService([])
    await expect(service.buildInjectionBlock({ query: '部署', projectScopeId: 'a'.repeat(16) })).resolves.toBe(null)
  })

  it('格式契约：标题、Project/User 分组与固定 Rules 三行', async () => {
    const service = createService([
      structured({ id: 'mem_p', content: '项目用 pnpm' }),
      structured({ id: 'mem_g', group: 'structured-global', kind: 'preference', explicitness: 'user_explicit', content: '偏好中文注释' })
    ])
    const block = await service.buildInjectionBlock({ query: '包管理', projectScopeId: 'a'.repeat(16) })
    expect(block).not.toBeNull()
    expect(block!.startsWith('=== Relevant Memory ===')).toBe(true)
    expect(block!).toContain('Project:\n- [decision] 项目用 pnpm')
    expect(block!).toContain('User:\n- [explicit preference] 偏好中文注释')
    expect(block!).toContain('Rules:\n- Treat memory as historical evidence.')
    expect(block!).toContain('- Current user instructions and workspace state take priority.')
    expect(block!).toContain(
      '- Observed preferences are advisory and must not silently decide unspecified architecture choices.'
    )
  })

  it('observed 偏好带 advisory 标注', async () => {
    const service = createService([
      structured({
        id: 'mem_obs',
        group: 'structured-global',
        kind: 'preference',
        explicitness: 'observed',
        content: '常写单元测试'
      })
    ])
    const block = await service.buildInjectionBlock({ query: '测试', projectScopeId: 'a'.repeat(16) })
    expect(block).toContain('- [observed preference, advisory] 常写单元测试')
  })

  it('文档命中渲染为 [relPath] 片段', async () => {
    const service = createService([documentResult()])
    const block = await service.buildInjectionBlock({ query: '部署', projectScopeId: 'a'.repeat(16) })
    expect(block).toContain('[MEMORY.md] # 项目记忆 部署使用 pnpm。')
  })

  it('单条 structured 超长截断到上限内', async () => {
    const service = createService([structured({ id: 'mem_long', content: '长'.repeat(500) })])
    const block = await service.buildInjectionBlock({ query: '长', projectScopeId: 'a'.repeat(16) })
    const line = block!.split('\n').find((l) => l.includes('[decision]'))!
    expect(line.length).toBeLessThanOrEqual('- [decision] '.length + MEMORY_PREFETCH_STRUCTURED_MAX_CHARS)
    expect(line.endsWith('…')).toBe(true)
  })

  it('分组条数上限：project ≤4、global ≤2、文档 ≤2', async () => {
    const results: MemorySearchResult[] = [
      ...Array.from({ length: 6 }, (_, i) => structured({ id: `mem_p${i}`, memoryKey: `k${i}` })),
      ...Array.from({ length: 4 }, (_, i) =>
        structured({ id: `mem_g${i}`, group: 'structured-global', kind: 'preference', explicitness: 'user_explicit', memoryKey: `gk${i}` })
      ),
      ...Array.from({ length: 4 }, (_, i) => documentResult({ id: `doc${i}.md`, relPath: `doc${i}.md` }))
    ]
    const service = createService(results)
    const block = await service.buildInjectionBlock({ query: '查询', projectScopeId: 'a'.repeat(16) })

    const projectLines = block!.split('\n').filter((l) => l.startsWith('- [decision]'))
    const userLines = block!.split('\n').filter((l) => l.startsWith('- [explicit preference]'))
    const docLines = block!.split('\n').filter((l) => l.startsWith('- [doc'))
    expect(projectLines).toHaveLength(MEMORY_PREFETCH_PROJECT_STRUCTURED_MAX_ITEMS)
    expect(userLines).toHaveLength(MEMORY_PREFETCH_GLOBAL_MAX_ITEMS)
    expect(docLines).toHaveLength(MEMORY_PREFETCH_DOCUMENT_MAX_ITEMS)
  })

  it('总块字符不超预算', async () => {
    const results: MemorySearchResult[] = Array.from({ length: 20 }, (_, i) =>
      structured({ id: `mem_${i}`, memoryKey: `k${i}`, content: '内容'.repeat(200) })
    )
    const service = createService(results)
    const block = await service.buildInjectionBlock({ query: '内容', projectScopeId: 'a'.repeat(16) })
    expect(block!.length).toBeLessThanOrEqual(MEMORY_PREFETCH_TOTAL_MAX_CHARS)
    expect(block!).toContain('Rules:')
  })

  it('检索参数固定为默认模式并带 prefetch 预算', async () => {
    let captured: MemorySearchInput | undefined
    const service = createService([], (input) => {
      captured = input
    })
    await service.buildInjectionBlock({ query: '部署', projectScopeId: 'a'.repeat(16), workspaceRoot: 'D:/ws' })
    expect(captured).toMatchObject({
      query: '部署',
      projectScopeId: 'a'.repeat(16),
      workspaceRoot: 'D:/ws',
      history: false
    })
  })
})
