/**
 * toolCallGrouping 边界单测
 */
import { describe, expect, it } from 'vitest'
import {
  buildBlockRenderUnits,
  buildToolCallRenderUnits,
  getToolGroupSummary,
  getToolGroupSummaryParts
} from '../../../src/renderer/features/chat/toolCallGrouping'
import type { RendererMessageBlock, RendererToolBlock } from '../../../src/renderer/stores/types'
import type { ExtendedToolCall } from '../../../src/renderer/stores/types'

function toolBlock(
  id: string,
  toolName: string,
  args: Record<string, unknown> = {}
): RendererToolBlock {
  return {
    type: 'tool',
    toolCallId: id,
    toolName,
    arguments: args,
    status: 'success'
  }
}

function extendedToolCall(
  id: string,
  name: string,
  args: Record<string, unknown> = {}
): ExtendedToolCall {
  return { id, name, arguments: args, status: 'success' }
}

describe('buildBlockRenderUnits', () => {
  it('空 blocks 返回空数组', () => {
    expect(buildBlockRenderUnits(undefined, 'default')).toEqual([])
    expect(buildBlockRenderUnits([], 'default')).toEqual([])
  })

  it('相邻 3 个 read 合并为 toolGroup', () => {
    const blocks: RendererMessageBlock[] = [
      toolBlock('1', 'read', { path: 'a.ts' }),
      toolBlock('2', 'read', { path: 'b.ts' }),
      toolBlock('3', 'read', { path: 'c.ts' })
    ]
    const units = buildBlockRenderUnits(blocks, 'default')
    expect(units).toHaveLength(1)
    expect(units[0]).toMatchObject({ kind: 'toolGroup', toolName: 'read' })
    if (units[0].kind === 'toolGroup') {
      expect(units[0].blocks).toHaveLength(3)
    }
  })

  it('单个 read 不聚合', () => {
    const blocks = [toolBlock('1', 'read', { path: 'a.ts' })]
    const units = buildBlockRenderUnits(blocks, 'default')
    expect(units).toEqual([{ kind: 'tool', block: blocks[0] }])
  })

  it('text 打断连续段：read×2 + text + read×2 → 两个 group', () => {
    const blocks: RendererMessageBlock[] = [
      toolBlock('1', 'read', { path: 'a.ts' }),
      toolBlock('2', 'read', { path: 'b.ts' }),
      { type: 'text', content: '说明' },
      toolBlock('3', 'read', { path: 'c.ts' }),
      toolBlock('4', 'read', { path: 'd.ts' })
    ]
    const units = buildBlockRenderUnits(blocks, 'default')
    expect(units.map(u => u.kind)).toEqual(['toolGroup', 'block', 'toolGroup'])
  })

  it('thinking 打断连续段', () => {
    const blocks: RendererMessageBlock[] = [
      toolBlock('1', 'grep', { pattern: 'foo' }),
      toolBlock('2', 'grep', { pattern: 'bar' }),
      { type: 'thinking', content: '思考中' },
      toolBlock('3', 'grep', { pattern: 'baz' })
    ]
    const units = buildBlockRenderUnits(blocks, 'default')
    expect(units.map(u => u.kind)).toEqual(['toolGroup', 'block', 'tool'])
  })

  it('工具名切换：read×2 + grep×2 → 两个 group', () => {
    const blocks: RendererMessageBlock[] = [
      toolBlock('1', 'read', { path: 'a.ts' }),
      toolBlock('2', 'read', { path: 'b.ts' }),
      toolBlock('3', 'grep', { pattern: 'x' }),
      toolBlock('4', 'grep', { pattern: 'y' })
    ]
    const units = buildBlockRenderUnits(blocks, 'default')
    expect(units).toHaveLength(2)
    expect(units[0]).toMatchObject({ kind: 'toolGroup', toolName: 'read' })
    expect(units[1]).toMatchObject({ kind: 'toolGroup', toolName: 'grep' })
  })

  it('不可聚合工具切断 buffer：read×2 + bash + read×2', () => {
    const blocks: RendererMessageBlock[] = [
      toolBlock('1', 'read', { path: 'a.ts' }),
      toolBlock('2', 'read', { path: 'b.ts' }),
      toolBlock('3', 'bash', { command: 'npm test' }),
      toolBlock('4', 'read', { path: 'c.ts' }),
      toolBlock('5', 'read', { path: 'd.ts' })
    ]
    const units = buildBlockRenderUnits(blocks, 'default')
    expect(units.map(u => u.kind)).toEqual(['toolGroup', 'tool', 'toolGroup'])
  })

  it('todo_write 单独输出，不进入 group', () => {
    const blocks = [
      toolBlock('1', 'read', { path: 'a.ts' }),
      toolBlock('2', 'todo_write', { todos: [] }),
      toolBlock('3', 'read', { path: 'b.ts' })
    ]
    const units = buildBlockRenderUnits(blocks, 'default')
    expect(units.map(u => u.kind)).toEqual(['tool', 'tool', 'tool'])
  })

  it('plan 模式隐藏 write 时跳过但不 flush，两侧 read 可继续聚合', () => {
    const blocks: RendererMessageBlock[] = [
      toolBlock('1', 'read', { path: 'a.ts' }),
      toolBlock('2', 'write', { path: 'out.ts', content: 'x' }),
      toolBlock('3', 'read', { path: 'b.ts' }),
      toolBlock('4', 'read', { path: 'c.ts' })
    ]
    const units = buildBlockRenderUnits(blocks, 'plan')
    // write 不可见且不进入 buffer，3 个 read 视为连续同类段
    expect(units.map(u => u.kind)).toEqual(['toolGroup'])
  })
})

describe('buildToolCallRenderUnits', () => {
  it('相邻 read×3 聚合', () => {
    const toolCalls = [
      extendedToolCall('1', 'read', { path: 'a.ts' }),
      extendedToolCall('2', 'read', { path: 'b.ts' }),
      extendedToolCall('3', 'read', { path: 'c.ts' })
    ]
    const units = buildToolCallRenderUnits(toolCalls, 'default')
    expect(units).toHaveLength(1)
    expect(units[0].kind).toBe('toolGroup')
  })

  it('bash 切断同类连续', () => {
    const toolCalls = [
      extendedToolCall('1', 'read', { path: 'a.ts' }),
      extendedToolCall('2', 'read', { path: 'b.ts' }),
      extendedToolCall('3', 'bash', { command: 'ls' }),
      extendedToolCall('4', 'read', { path: 'c.ts' })
    ]
    const units = buildToolCallRenderUnits(toolCalls, 'default')
    expect(units.map(u => u.kind)).toEqual(['toolGroup', 'tool', 'tool'])
  })
})

describe('getToolGroupSummary', () => {
  it('read：首个文件名 + 等 N 个文件', () => {
    const blocks = [
      toolBlock('1', 'read', { path: 'src/webSearchTool.ts' }),
      toolBlock('2', 'read', { path: 'b.ts' }),
      toolBlock('3', 'read', { path: 'c.ts' })
    ]
    expect(getToolGroupSummary('read', blocks)).toBe('读取 webSearchTool.ts 等 3 个文件')
  })

  it('read：2 条时写「等 2 个文件」', () => {
    const blocks = [
      toolBlock('1', 'read', { path: 'a.ts' }),
      toolBlock('2', 'read', { path: 'b.ts' })
    ]
    expect(getToolGroupSummaryParts('read', blocks).suffix).toBe('等 2 个文件')
  })

  it('grep：缺 pattern 时回退', () => {
    const blocks = [toolBlock('1', 'grep', {}), toolBlock('2', 'grep', { pattern: 'x' })]
    expect(getToolGroupSummary('grep', blocks)).toContain('搜索')
    expect(getToolGroupSummary('grep', blocks)).toContain('等 2 次')
  })

  it('web_search：首个 query + 数量', () => {
    const blocks = [
      toolBlock('1', 'web_search', { query: 'react hook' }),
      toolBlock('2', 'web_search', { query: 'vue' }),
      toolBlock('3', 'web_search', { query: 'svelte' })
    ]
    expect(getToolGroupSummary('web_search', blocks)).toBe('搜索 react hook 等 3 次')
  })

  it('find / ls 中文摘要', () => {
    const findBlocks = [toolBlock('1', 'find', { pattern: '*.ts' }), toolBlock('2', 'find', { pattern: '*.tsx' })]
    expect(getToolGroupSummary('find', findBlocks)).toBe('定位 *.ts 等 2 次')

    const lsBlocks = [toolBlock('1', 'ls', { path: 'src' }), toolBlock('2', 'ls', { path: 'tests' })]
    expect(getToolGroupSummary('ls', lsBlocks)).toBe('列出 src 等 2 个目录')
  })
})
