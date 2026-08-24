/**
 * toolCallGrouping 边界单测
 */
import { describe, expect, it } from 'vitest'
import {
  buildBlockRenderUnits,
  buildToolCallRenderUnits,
  getToolGroupSummary
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

  it('探索工具切换：read×2 + grep×2 → 一个探索 group', () => {
    const blocks: RendererMessageBlock[] = [
      toolBlock('1', 'read', { path: 'a.ts' }),
      toolBlock('2', 'read', { path: 'b.ts' }),
      toolBlock('3', 'grep', { pattern: 'x' }),
      toolBlock('4', 'grep', { pattern: 'y' })
    ]
    const units = buildBlockRenderUnits(blocks, 'default')
    expect(units).toHaveLength(1)
    expect(units[0]).toMatchObject({ kind: 'toolGroup', toolName: 'read' })
    if (units[0].kind === 'toolGroup') {
      expect(units[0].blocks).toHaveLength(4)
    }
  })

  it('不同工具族切断 buffer：read×2 + bash + read×2', () => {
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

  it('todo_write 由顶部面板统一展示，不在 buildBlockRenderUnits 中输出', () => {
    const blocks = [
      toolBlock('1', 'read', { path: 'a.ts' }),
      toolBlock('2', 'todo_write', { todos: [] }),
      toolBlock('3', 'read', { path: 'b.ts' })
    ]
    const units = buildBlockRenderUnits(blocks, 'default')
    // todo_write 被 shouldRenderToolBlock 过滤，两侧 read 仍视为连续同类段
    expect(units.map(u => u.kind)).toEqual(['toolGroup'])
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

  it('相邻 write 与 edit 合并为写入 group', () => {
    const blocks: RendererMessageBlock[] = [
      toolBlock('w1', 'write', { path: 'a.ts', content: 'a' }),
      toolBlock('e1', 'edit', { path: 'b.ts', old: 'a', new: 'b' })
    ]
    const units = buildBlockRenderUnits(blocks, 'default')
    expect(units).toHaveLength(1)
    expect(units[0]).toMatchObject({ kind: 'toolGroup', toolName: 'write' })
  })

  it('相邻 bash 合并为命令 group', () => {
    const blocks: RendererMessageBlock[] = [
      toolBlock('b1', 'bash', { command: 'npm test' }),
      toolBlock('b2', 'bash', { command: 'npm run typecheck' })
    ]
    const units = buildBlockRenderUnits(blocks, 'default')
    expect(units).toHaveLength(1)
    expect(units[0]).toMatchObject({ kind: 'toolGroup', toolName: 'bash' })
  })

  it('提问卡 / 计划卡 / 子代理打断探索连续段', () => {
    const ask = buildBlockRenderUnits(
      [
        toolBlock('1', 'read', { path: 'a.ts' }),
        toolBlock('2', 'read', { path: 'b.ts' }),
        toolBlock('q', 'askQuestion', { questions: [] }),
        toolBlock('3', 'read', { path: 'c.ts' }),
        toolBlock('4', 'read', { path: 'd.ts' })
      ],
      'default'
    )
    expect(ask.map(u => u.kind)).toEqual(['toolGroup', 'tool', 'toolGroup'])

    const plan = buildBlockRenderUnits(
      [
        toolBlock('1', 'read', { path: 'a.ts' }),
        toolBlock('2', 'read', { path: 'b.ts' }),
        toolBlock('p', 'save_plan', { title: '计划' }),
        toolBlock('3', 'grep', { pattern: 'x' }),
        toolBlock('4', 'grep', { pattern: 'y' })
      ],
      'default'
    )
    expect(plan.map(u => u.kind)).toEqual(['toolGroup', 'tool', 'toolGroup'])

    const task = buildBlockRenderUnits(
      [
        toolBlock('1', 'bash', { command: 'ls' }),
        toolBlock('2', 'bash', { command: 'pwd' }),
        toolBlock('t', 'task', { task: '调研' }),
        toolBlock('3', 'write', { path: 'a.ts', content: 'a' }),
        toolBlock('4', 'edit', { path: 'b.ts' })
      ],
      'default'
    )
    expect(task.map(u => u.kind)).toEqual(['toolGroup', 'tool', 'toolGroup'])
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
  it('探索工具：显示文件数量', () => {
    const blocks = [
      toolBlock('1', 'read', { path: 'src/webSearchTool.ts' }),
      toolBlock('2', 'read', { path: 'b.ts' }),
      toolBlock('3', 'read', { path: 'c.ts' })
    ]
    expect(getToolGroupSummary('read', blocks)).toBe('探索 3 文件')
  })

  it('探索工具混排：显示文件与搜索数量', () => {
    const blocks = [
      toolBlock('1', 'read', { path: 'a.ts' }),
      toolBlock('2', 'grep', { pattern: 'foo' }),
      toolBlock('3', 'find', { pattern: '*.tsx' })
    ]
    expect(getToolGroupSummary('read', blocks)).toBe('探索 2 搜索 1 文件')
  })

  it('搜索工具：缺 pattern 时仍显示搜索数量', () => {
    const blocks = [toolBlock('1', 'grep', {}), toolBlock('2', 'grep', { pattern: 'x' })]
    expect(getToolGroupSummary('grep', blocks)).toBe('探索 2 搜索')
  })

  it('web_search：显示搜索数量', () => {
    const blocks = [
      toolBlock('1', 'web_search', { query: 'react hook' }),
      toolBlock('2', 'web_search', { query: 'vue' }),
      toolBlock('3', 'web_search', { query: 'svelte' })
    ]
    expect(getToolGroupSummary('web_search', blocks)).toBe('探索 3 搜索')
  })

  it('find / ls 显示探索数量', () => {
    const findBlocks = [toolBlock('1', 'find', { pattern: '*.ts' }), toolBlock('2', 'find', { pattern: '*.tsx' })]
    expect(getToolGroupSummary('find', findBlocks)).toBe('探索 2 搜索')

    const lsBlocks = [toolBlock('1', 'ls', { path: 'src' }), toolBlock('2', 'ls', { path: 'tests' })]
    expect(getToolGroupSummary('ls', lsBlocks)).toBe('探索 2 目录')
  })

  it('写入与编辑混排：分别显示数量', () => {
    const blocks = [
      toolBlock('1', 'write', { path: 'a.ts', content: 'a' }),
      toolBlock('2', 'edit', { path: 'b.ts', old: 'a', new: 'b' })
    ]
    expect(getToolGroupSummary('write', blocks)).toBe('写入 1 写入 1 编辑')
  })

  it('仅写入或仅编辑', () => {
    expect(getToolGroupSummary('write', [
      toolBlock('1', 'write', { path: 'a.ts' }),
      toolBlock('2', 'write', { path: 'b.ts' })
    ])).toBe('写入 2 写入')
    expect(getToolGroupSummary('edit', [
      toolBlock('1', 'edit', { path: 'a.ts' }),
      toolBlock('2', 'edit', { path: 'b.ts' })
    ])).toBe('写入 2 编辑')
  })

  it('命令工具：显示命令数量', () => {
    const blocks = [
      toolBlock('1', 'bash', { command: 'npm test' }),
      toolBlock('2', 'bash', { command: 'npm run typecheck' })
    ]
    expect(getToolGroupSummary('bash', blocks)).toBe('运行 2 条命令')
  })
})
