/**
 * memory_search 工具单测：组合检索接线、history 参数、分组标注与降级路径。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMemorySearchTool, formatMemorySearchResults } from '../../../../src/runtime/tools/memorySearch'
import { DEFAULT_NOVA_SETTINGS } from '../../../../src/runtime/settings/novaSettings'
import type { MemoryRetrievalService } from '../../../../src/runtime/memory/retrieval/MemoryRetrievalService'
import type { MemorySearchResult } from '../../../../src/runtime/memory/retrieval/MemoryRetriever'
import type { ToolContext } from '../../../../src/runtime/tools/types'
import { createReadState } from '../../../../src/runtime/tools/editTool'

const baseCtx: ToolContext = {
  workingDir: '/tmp/project',
  readState: createReadState()
}

function structured(overrides: Partial<Extract<MemorySearchResult, { group: 'structured-project' | 'structured-global' }>>): MemorySearchResult {
  return {
    id: 'mem_x',
    group: 'structured-project',
    kind: 'decision',
    content: '主数据库为 PostgreSQL',
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

function documentResult(overrides: Partial<Extract<MemorySearchResult, { group: 'document' }>> = {}): MemorySearchResult {
  return {
    id: 'MEMORY.md',
    group: 'document',
    kind: 'document',
    relPath: 'MEMORY.md',
    body: '# 项目记忆\n部署密令是紫罗兰',
    advisory: false,
    historicalNote: null,
    ...overrides
  }
}

describe('memory_search tool', () => {
  const search = vi.fn()
  const loadSettings = vi.fn(() => ({ ...DEFAULT_NOVA_SETTINGS, memoryEnabled: true }))
  const tool = createMemorySearchTool({
    getMemoryRetrievalService: () => ({ search } as unknown as MemoryRetrievalService),
    loadSettings
  })

  beforeEach(() => {
    search.mockReset().mockResolvedValue([])
    loadSettings.mockReturnValue({ ...DEFAULT_NOVA_SETTINGS, memoryEnabled: true })
  })

  it('结果按 Project / Global / Historical 分组标注，observed global 带 advisory', async () => {
    search.mockResolvedValue([
      structured({ id: 'mem_p', content: '项目用 pnpm' }),
      documentResult(),
      structured({
        id: 'mem_g',
        group: 'structured-global',
        kind: 'preference',
        explicitness: 'observed',
        content: '偏好中文注释'
      }),
      structured({ id: 'mem_old', content: '旧方案用 SQLite', status: 'superseded', historicalNote: 'superseded' })
    ])

    const result = await tool.execute({ query: '数据库' }, baseCtx)
    expect(result.success).toBe(true)
    expect(result.output).toContain('找到 4 条相关记忆')
    expect(result.output).toContain('Project memory:')
    expect(result.output).toContain('[decision] 项目用 pnpm')
    expect(result.output).toContain('MEMORY.md — # 项目记忆')
    expect(result.output).toContain('紫罗兰')
    expect(result.output).toContain('Global user memory:')
    expect(result.output).toContain('[preference] (observed / advisory) 偏好中文注释')
    expect(result.output).toContain('Historical memory:')
    expect(result.output).toContain('（已被替代）')
    // 不输出内部排序分
    expect(result.output).not.toMatch(/score/)
  })

  it('history 参数透传给检索服务', async () => {
    await tool.execute({ query: '旧方案', history: true }, baseCtx)
    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({ query: '旧方案', history: true })
    )

    await tool.execute({ query: '旧方案' }, baseCtx)
    expect(search).toHaveBeenLastCalledWith(expect.objectContaining({ history: false }))
  })

  it('检索入参携带 scope 与工作区根（懒校验用）', async () => {
    await tool.execute({ query: 'x' }, baseCtx)
    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceRoot: '/tmp/project', projectScopeId: expect.any(String) })
    )
  })

  it('无命中返回明确提示（含 history 建议）', async () => {
    search.mockResolvedValue([])
    const result = await tool.execute({ query: '不存在的关键词' }, baseCtx)
    expect(result.output).toContain('未找到相关记忆')
    expect(result.output).toContain('history: true')
  })

  it('memoryEnabled 关闭时返回提示且不检索', async () => {
    loadSettings.mockReturnValue({ ...DEFAULT_NOVA_SETTINGS, memoryEnabled: false })
    const result = await tool.execute({ query: 'test' }, baseCtx)
    expect(result.output).toContain('记忆系统未启用')
    expect(search).not.toHaveBeenCalled()
  })

  it('无工作区时返回提示', async () => {
    const result = await tool.execute(
      { query: 'test' },
      { ...baseCtx, workingDir: '' }
    )
    expect(result.output).toContain('无工作区')
    expect(search).not.toHaveBeenCalled()
  })

  it('检索服务不可用时返回提示', async () => {
    const degraded = createMemorySearchTool({
      getMemoryRetrievalService: () => null,
      loadSettings
    })
    const result = await degraded.execute({ query: 'test' }, baseCtx)
    expect(result.output).toContain('记忆服务暂不可用')
  })

  it('检索失败返回可理解错误（fail-soft 不中断会话）', async () => {
    search.mockRejectedValue(new Error('db unavailable'))
    const result = await tool.execute({ query: 'test' }, baseCtx)
    expect(result.success).toBe(false)
    expect(result.error).toContain('记忆检索失败')
    expect(result.error).toContain('db unavailable')
  })

  it('query 为空返回参数错误', async () => {
    const result = await tool.execute({ query: '  ' }, baseCtx)
    expect(result.success).toBe(false)
    expect(result.error).toContain('query 参数不能为空')
  })
})

describe('formatMemorySearchResults', () => {
  it('空命中列表返回未找到提示', () => {
    expect(formatMemorySearchResults([], 'q')).toContain('未找到相关记忆')
  })

  it('history 标注：撤回与需核对各有独立文案', () => {
    const output = formatMemorySearchResults(
      [
        structured({ id: 'a', content: '已撤回的偏好', status: 'retracted', historicalNote: 'retracted' }),
        structured({ id: 'b', content: '待核对的事实', status: 'needs_verification', historicalNote: 'needs-verification' })
      ],
      'q'
    )
    expect(output).toContain('（已撤回）')
    expect(output).toContain('（需与当前工作区核对）')
  })
})
