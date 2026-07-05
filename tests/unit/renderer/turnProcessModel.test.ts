/**
 * turnProcessModel 分区与摘要单测（T1~T10）
 */
import { describe, expect, it } from 'vitest'
import {
  buildProcessTimeline,
  buildTurnRenderModel,
  BUBBLE_TOOL_NAMES,
  countHunkLineChanges,
  prepareBubbleBlocks
} from '../../../src/renderer/features/chat/turnProcessModel'
import { computeFileDiff } from '../../../src/shared/diff/compute'
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

describe('buildTurnRenderModel', () => {
  it('T1: 无 tool，仅 text → hasProcess=false，全进 answer', () => {
    const blocks: RendererMessageBlock[] = [{ type: 'text', content: '结论全文' }]
    const model = buildTurnRenderModel({ blocks, toolCalls: [], mode: 'default', phase: 'completed' })
    expect(model.hasProcess).toBe(false)
    expect(model.processTimeline).toHaveLength(0)
    expect(model.answerUnits).toHaveLength(1)
    expect(model.answerUnits[0].kind).toBe('block')
  })

  it('T2: text → tool → text，最后 text 在 answer；前 text 在 process', () => {
    const blocks: RendererMessageBlock[] = [
      { type: 'text', content: '中间说明' },
      toolBlock('1', 'read', { path: 'a.ts' }),
      { type: 'text', content: '最终结论' }
    ]
    const model = buildTurnRenderModel({ blocks, toolCalls: [], mode: 'default', phase: 'completed' })
    expect(model.hasProcess).toBe(true)
    const processTexts = model.processTimeline.filter(
      s => s.kind === 'block' && s.block.type === 'text'
    )
    expect(processTexts).toHaveLength(1)
    expect(model.answerUnits).toHaveLength(1)
    if (model.answerUnits[0].kind === 'block') {
      expect(model.answerUnits[0].block.type).toBe('text')
      expect((model.answerUnits[0].block as { content: string }).content).toBe('最终结论')
    }
  })

  it('T3: tool → text → tool → text，仅最后 text 在 answer', () => {
    const blocks: RendererMessageBlock[] = [
      toolBlock('1', 'bash', { command: 'npm test' }),
      { type: 'text', content: '中间' },
      toolBlock('2', 'read', { path: 'b.ts' }),
      { type: 'text', content: '结论' }
    ]
    const model = buildTurnRenderModel({ blocks, toolCalls: [], mode: 'default', phase: 'completed' })
    expect(model.hasProcess).toBe(true)
    if (model.answerUnits[0].kind === 'block') {
      expect((model.answerUnits[0].block as { content: string }).content).toBe('结论')
    }
  })

  it('T4: 含 todo_write → todo 在 bubble，不进 process', () => {
    const blocks: RendererMessageBlock[] = [
      toolBlock('t1', 'todo_write', { todos: [] }),
      toolBlock('1', 'read', { path: 'a.ts' }),
      { type: 'text', content: 'done' }
    ]
    expect(BUBBLE_TOOL_NAMES.has('todo_write')).toBe(true)
    const model = buildTurnRenderModel({ blocks, toolCalls: [], mode: 'default', phase: 'completed' })
    expect(model.bubbleUnits).toHaveLength(1)
    expect(model.bubbleUnits[0].kind).toBe('tool')
    expect(model.processTimeline.some(s => s.kind === 'tool' && s.block.toolName === 'todo_write')).toBe(false)
  })

  it('多次 todo_write 冒泡区仅保留最后一次快照', () => {
    const blocks: RendererMessageBlock[] = [
      toolBlock('t1', 'todo_write', { todos: [{ content: 'a', status: 'pending' }] }),
      toolBlock('1', 'read', { path: 'a.ts' }),
      toolBlock('t2', 'todo_write', {
        todos: [
          { content: 'a', status: 'completed' },
          { content: 'b', status: 'pending' }
        ]
      }),
      { type: 'text', content: 'done' }
    ]
    const model = buildTurnRenderModel({ blocks, toolCalls: [], mode: 'default', phase: 'completed' })
    expect(model.bubbleUnits).toHaveLength(1)
    if (model.bubbleUnits[0].kind === 'tool') {
      expect(model.bubbleUnits[0].block.toolCallId).toBe('t2')
    }
  })

  it('多次 askQuestion 冒泡区仅保留最后一次（含已完成）', () => {
    const blocks: RendererMessageBlock[] = [
      toolBlock('q1', 'askQuestion', { questions: [{ question: 'Q1', options: [{ label: 'A' }] }] }),
      toolBlock('q2', 'askQuestion', { questions: [{ question: 'Q2', options: [{ label: 'B' }] }] }),
      toolBlock('1', 'read', { path: 'a.ts' }),
      { type: 'text', content: 'done' }
    ]
    const model = buildTurnRenderModel({ blocks, toolCalls: [], mode: 'default', phase: 'completed' })
    expect(model.bubbleUnits).toHaveLength(1)
    if (model.bubbleUnits[0].kind === 'tool') {
      expect(model.bubbleUnits[0].block.toolCallId).toBe('q2')
    }
  })

  it('已完成的 askQuestion 在冒泡区保留最后一次记录', () => {
    const blocks: RendererMessageBlock[] = [
      toolBlock('q1', 'askQuestion', { questions: [{ question: 'Q1', options: [{ label: 'A' }] }] }),
      toolBlock('1', 'read', { path: 'a.ts' }),
      { type: 'text', content: 'done' }
    ]
    const model = buildTurnRenderModel({ blocks, toolCalls: [], mode: 'default', phase: 'completed' })
    expect(model.bubbleUnits).toHaveLength(1)
    if (model.bubbleUnits[0].kind === 'tool') {
      expect(model.bubbleUnits[0].block.toolName).toBe('askQuestion')
    }
  })

  it('进行中的 askQuestion 冒泡区仅保留最后一次', () => {
    const blocks: RendererMessageBlock[] = [
      { ...toolBlock('q1', 'askQuestion', { questions: [] }), status: 'success' },
      { ...toolBlock('q2', 'askQuestion', { questions: [] }), status: 'running' },
      toolBlock('1', 'read', { path: 'a.ts' }),
      { type: 'text', content: 'done' }
    ]
    const model = buildTurnRenderModel({ blocks, toolCalls: [], mode: 'default', phase: 'live' })
    expect(model.bubbleUnits).toHaveLength(1)
    if (model.bubbleUnits[0].kind === 'tool') {
      expect(model.bubbleUnits[0].block.toolCallId).toBe('q2')
    }
  })

  it('prepareBubbleBlocks 顺序：Todos 在 askQuestion 之前', () => {
    const blocks: RendererMessageBlock[] = [
      { ...toolBlock('q1', 'askQuestion', { questions: [] }), status: 'running' },
      toolBlock('t1', 'todo_write', { todos: [] })
    ]
    const prepared = prepareBubbleBlocks(blocks, 'default')
    expect(prepared).toHaveLength(2)
    expect(prepared[0].type).toBe('tool')
    expect((prepared[0] as RendererToolBlock).toolName).toBe('todo_write')
    expect((prepared[1] as RendererToolBlock).toolName).toBe('askQuestion')
  })

  it('T5: 含 askQuestion → 进行中时进 bubble，已完成不堆叠', () => {
    const blocks: RendererMessageBlock[] = [
      { ...toolBlock('q1', 'askQuestion', { questions: [] }), status: 'running' },
      toolBlock('1', 'grep', { pattern: 'foo' }),
      { type: 'text', content: 'answer' }
    ]
    const model = buildTurnRenderModel({ blocks, toolCalls: [], mode: 'default', phase: 'live' })
    expect(model.bubbleUnits).toHaveLength(1)
    if (model.bubbleUnits[0].kind === 'tool') {
      expect(model.bubbleUnits[0].block.toolName).toBe('askQuestion')
    }
  })

  it('T6: 连续 read×3 → process timeline 含 toolGroup', () => {
    const blocks: RendererMessageBlock[] = [
      toolBlock('1', 'read', { path: 'a.ts' }),
      toolBlock('2', 'read', { path: 'b.ts' }),
      toolBlock('3', 'read', { path: 'c.ts' }),
      { type: 'text', content: 'done' }
    ]
    const model = buildTurnRenderModel({ blocks, toolCalls: [], mode: 'default', phase: 'completed' })
    expect(model.processTimeline.some(s => s.kind === 'toolGroup')).toBe(true)
  })

  it('T7: plan 模式隐藏 write → write 不影响 lastToolIndex，且不进 answerUnits', () => {
    const blocks: RendererMessageBlock[] = [
      toolBlock('r1', 'read', { path: 'a.ts' }),
      toolBlock('w1', 'write', { path: 'hidden.ts', content: 'x' }),
      { type: 'text', content: '仅文本' }
    ]
    const model = buildTurnRenderModel({ blocks, toolCalls: [], mode: 'plan', phase: 'completed' })
    expect(model.hasProcess).toBe(true)
    const answerTools = model.answerUnits.filter(
      u => u.kind === 'tool' || u.kind === 'toolGroup'
    )
    expect(answerTools).toHaveLength(0)
    if (model.answerUnits[0]?.kind === 'block') {
      expect((model.answerUnits[0].block as { content: string }).content).toBe('仅文本')
    }
  })

  it('T8: diffCache 有 hunks → additions/deletions 按 content +/- 计数', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`)
    const oldContent = lines.join('\n')
    const changed = [...lines]
    changed[14] = 'line 15 CHANGED'
    const entry = computeFileDiff('a.ts', oldContent, changed.join('\n'), 'modified')

    const blocks: RendererMessageBlock[] = [
      toolBlock('1', 'edit', { path: 'a.ts' }),
      { type: 'text', content: 'done' }
    ]
    const model = buildTurnRenderModel({
      blocks,
      toolCalls: [],
      mode: 'default',
      phase: 'completed',
      diffCache: { diffs: [entry], reviews: {} }
    })
    expect(model.summary.diffStatsReady).toBe(true)
    expect(model.summary.additions).toBe(1)
    expect(model.summary.deletions).toBe(1)

    // 回归：hunk 头跨度含上下文，会远大于真实 +/- 行数
    const spanAdd = entry.hunks.reduce((s, h) => s + h.newLines, 0)
    const spanDel = entry.hunks.reduce((s, h) => s + h.oldLines, 0)
    expect(spanAdd).toBeGreaterThan(model.summary.additions!)
    expect(spanDel).toBeGreaterThan(model.summary.deletions!)
  })

  it('countHunkLineChanges 不计上下文空格行', () => {
    const hunk = {
      oldStart: 1,
      oldLines: 7,
      newStart: 1,
      newLines: 7,
      content: ' line1\n-line2\n+line2 changed\n line3'
    }
    expect(countHunkLineChanges(hunk)).toEqual({ additions: 1, deletions: 1 })
  })

  it('T9: 无 blocks，有 toolCalls → 降级路径正确', () => {
    const toolCalls: ExtendedToolCall[] = [
      { id: '1', name: 'read', arguments: { path: 'a.ts' }, status: 'success' }
    ]
    const model = buildTurnRenderModel({
      blocks: undefined,
      toolCalls,
      mode: 'default',
      phase: 'completed',
      content: '结论',
      thinking: '思考'
    })
    expect(model.hasProcess).toBe(true)
    expect(model.processTimeline.length).toBeGreaterThan(0)
    expect(model.answerUnits.some(u => u.kind === 'block')).toBe(true)
  })

  it('T10: 仅 thinking + tools → answer 为空，hasProcess=true', () => {
    const blocks: RendererMessageBlock[] = [
      { type: 'thinking', content: '分析中' },
      toolBlock('1', 'bash', { command: 'npm test' })
    ]
    const model = buildTurnRenderModel({ blocks, toolCalls: [], mode: 'default', phase: 'completed' })
    expect(model.hasProcess).toBe(true)
    expect(model.answerUnits).toHaveLength(0)
    expect(model.summary.commandCount).toBe(1)
  })
})

describe('buildProcessTimeline', () => {
  it('保持 thinking → tool → text 交错顺序', () => {
    const blocks: RendererMessageBlock[] = [
      { type: 'thinking', content: 't' },
      toolBlock('1', 'read', { path: 'a.ts' }),
      { type: 'text', content: '中间' },
      toolBlock('2', 'bash', { command: 'x' })
    ]
    const timeline = buildProcessTimeline(blocks, 3, 'default')
    expect(timeline[0].kind).toBe('block')
    expect(timeline[1].kind).toBe('tool')
    expect(timeline[2].kind).toBe('block')
    expect(timeline[3].kind).toBe('tool')
  })
})
