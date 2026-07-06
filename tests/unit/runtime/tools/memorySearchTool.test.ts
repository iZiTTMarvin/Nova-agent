/**
 * memory_search 工具单测
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMemorySearchTool, formatMemorySearchResults } from '../../../../src/runtime/tools/memorySearch'
import { DEFAULT_NOVA_SETTINGS } from '../../../../src/runtime/settings/novaSettings'
import type { MemoryService } from '../../../../src/runtime/memory/MemoryService'
import type { ToolContext } from '../../../../src/runtime/tools/types'
import { createReadState } from '../../../../src/runtime/tools/editTool'

const baseCtx: ToolContext = {
  workingDir: '/tmp/project',
  readState: createReadState()
}

describe('memory_search tool', () => {
  const search = vi.fn()
  const loadSettings = vi.fn(() => ({ ...DEFAULT_NOVA_SETTINGS, memoryEnabled: true }))
  const tool = createMemorySearchTool({
    getMemoryService: () => ({ search } as unknown as MemoryService),
    loadSettings
  })

  beforeEach(() => {
    search.mockReset()
    loadSettings.mockReturnValue({ ...DEFAULT_NOVA_SETTINGS, memoryEnabled: true })
  })

  it('命中时格式化 relPath + snippet + score', async () => {
    search.mockReturnValue([
      {
        scopeId: 's1',
        relPath: 'MEMORY.md',
        body: '部署密令是紫罗兰',
        score: 2.34
      }
    ])

    const result = await tool.execute({ query: '部署' }, baseCtx)
    expect(result.success).toBe(true)
    expect(result.output).toContain('找到 1 条相关记忆')
    expect(result.output).toContain('MEMORY.md (score: 2.34)')
    expect(result.output).toContain('紫罗兰')
  })

  it('无命中返回明确提示', async () => {
    search.mockReturnValue([])
    const result = await tool.execute({ query: '不存在的关键词' }, baseCtx)
    expect(result.output).toContain('未找到相关记忆')
  })

  it('memoryEnabled 关闭时返回提示', async () => {
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
  })
})

describe('formatMemorySearchResults', () => {
  it('空命中列表', () => {
    expect(formatMemorySearchResults([], 'q')).toContain('未找到相关记忆')
  })
})
