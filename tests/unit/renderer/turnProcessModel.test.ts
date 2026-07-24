/**
 * turnProcessModel 分区与摘要单测（T1~T10）
 */
import { describe, expect, it } from 'vitest'
import {
  buildProcessTimeline,
  buildTurnRenderModel,
  countHunkLineChanges,
  normalizeThinkingForDisplay
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

  it('T4: todo_write 由顶部面板统一展示，不进 bubble 也不进 process', () => {
    const blocks: RendererMessageBlock[] = [
      toolBlock('t1', 'todo_write', { todos: [] }),
      toolBlock('1', 'read', { path: 'a.ts' }),
      { type: 'text', content: 'done' }
    ]
    const model = buildTurnRenderModel({ blocks, toolCalls: [], mode: 'default', phase: 'completed' })
    expect(model.bubbleUnits).toHaveLength(0)
    expect(model.processTimeline.some(s => s.kind === 'tool' && s.block.toolName === 'todo_write')).toBe(false)
  })

  it('多次 todo_write 不进入 bubble / process', () => {
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
    expect(model.bubbleUnits).toHaveLength(0)
  })

  it('text + askQuestion：按时间线 text 后紧跟 ask', () => {
    const blocks: RendererMessageBlock[] = [
      { type: 'text', content: '我将询问你' },
      toolBlock('q1', 'askQuestion', { questions: [{ question: 'Q1', options: [{ label: 'A' }] }] })
    ]
    const model = buildTurnRenderModel({ blocks, toolCalls: [], mode: 'default', phase: 'completed' })
    expect(model.bubbleUnits).toHaveLength(0)
    expect(model.hasProcess).toBe(false)
    expect(model.answerUnits).toHaveLength(2)
    expect(model.answerUnits[0].kind).toBe('block')
    expect(model.answerUnits[1].kind).toBe('tool')
    if (model.answerUnits[1].kind === 'tool') {
      expect(model.answerUnits[1].block.toolCallId).toBe('q1')
    }
  })

  it('read + text + askQuestion：ask 紧跟引导文案，不在 process', () => {
    const blocks: RendererMessageBlock[] = [
      toolBlock('1', 'read', { path: 'a.ts' }),
      { type: 'text', content: '我将询问你' },
      toolBlock('q1', 'askQuestion', { questions: [{ question: 'Q1', options: [{ label: 'A' }] }] })
    ]
    const model = buildTurnRenderModel({ blocks, toolCalls: [], mode: 'default', phase: 'completed' })
    expect(model.bubbleUnits).toHaveLength(0)
    expect(model.processTimeline.some(s => s.kind === 'tool' && s.block.toolName === 'askQuestion')).toBe(false)
    expect(model.answerUnits).toHaveLength(2)
    expect(model.answerUnits[0].kind).toBe('block')
    if (model.answerUnits[0].kind === 'block') {
      expect((model.answerUnits[0].block as { content: string }).content).toBe('我将询问你')
    }
    expect(model.answerUnits[1].kind).toBe('tool')
    if (model.answerUnits[1].kind === 'tool') {
      expect(model.answerUnits[1].block.toolCallId).toBe('q1')
    }
  })

  it('多次 askQuestion：按时间线各保留一次', () => {
    const blocks: RendererMessageBlock[] = [
      { type: 'text', content: '第一问' },
      toolBlock('q1', 'askQuestion', { questions: [{ question: 'Q1', options: [{ label: 'A' }] }] }),
      { type: 'text', content: '第二问' },
      toolBlock('q2', 'askQuestion', { questions: [{ question: 'Q2', options: [{ label: 'B' }] }] })
    ]
    const model = buildTurnRenderModel({ blocks, toolCalls: [], mode: 'default', phase: 'completed' })
    expect(model.bubbleUnits).toHaveLength(0)
    const askTools = model.answerUnits.filter(u => u.kind === 'tool')
    expect(askTools).toHaveLength(2)
    if (askTools[0].kind === 'tool' && askTools[1].kind === 'tool') {
      expect(askTools[0].block.toolCallId).toBe('q1')
      expect(askTools[1].block.toolCallId).toBe('q2')
    }
  })

  it('ask 落在后续可见工具之前：进入 process timeline', () => {
    const blocks: RendererMessageBlock[] = [
      { type: 'text', content: '先问' },
      toolBlock('q1', 'askQuestion', { questions: [] }),
      toolBlock('1', 'read', { path: 'a.ts' }),
      { type: 'text', content: 'done' }
    ]
    const model = buildTurnRenderModel({ blocks, toolCalls: [], mode: 'default', phase: 'completed' })
    expect(model.processTimeline.some(s => s.kind === 'tool' && s.block.toolName === 'askQuestion')).toBe(true)
    expect(model.answerUnits.filter(u => u.kind === 'tool')).toHaveLength(0)
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

  it('思考摘要复用展示规范化，不泄露 Markdown 标记', () => {
    const blocks: RendererMessageBlock[] = [
      {
        type: 'thinking',
        content:
          '**Planning initial repository inspection****Drafting detailed implementation plan**'
      },
      toolBlock('1', 'read', { path: 'a.ts' })
    ]

    const model = buildTurnRenderModel({
      blocks,
      toolCalls: [],
      mode: 'default',
      phase: 'completed'
    })

    expect(model.summary.thoughtPreview).toBe(
      'Planning initial repository inspection Drafting detailed implementation plan'
    )
  })
})

describe('normalizeThinkingForDisplay', () => {
  it('普通中文、列表和代码内容保持原意', () => {
    const input = '先检查调用链。\n\n- 读取入口\n- 验证测试\n\n`npm test`'
    expect(normalizeThinkingForDisplay(input)).toBe(input)
  })

  it('只拆分文本内部紧邻的加粗摘要，不改 Markdown 分隔线', () => {
    expect(normalizeThinkingForDisplay('**分析 A****分析 B**')).toBe(
      '**分析 A**\n\n**分析 B**'
    )
    expect(normalizeThinkingForDisplay('password****hidden')).toBe(
      'password****hidden'
    )
    expect(normalizeThinkingForDisplay('第一段\n\n****\n\n第二段')).toBe(
      '第一段\n\n****\n\n第二段'
    )
  })

  it('围栏代码与行内代码中的连续星号保持不变', () => {
    const input = [
      '`value****next`',
      '',
      '```text',
      'value****next',
      '```still-code',
      '**code A****code B**',
      '```',
      '',
      '`multi-line code starts',
      '**code C****code D**',
      'ends here`',
      '',
      '**摘要 A****摘要 B**'
    ].join('\n')
    const expected = [
      '`value****next`',
      '',
      '```text',
      'value****next',
      '```still-code',
      '**code A****code B**',
      '```',
      '',
      '`multi-line code starts',
      '**code C****code D**',
      'ends here`',
      '',
      '**摘要 A**',
      '',
      '**摘要 B**'
    ].join('\n')

    expect(normalizeThinkingForDisplay(input)).toBe(expected)
  })

  it('过程摘要跳过可变长度和波浪号围栏代码', () => {
    const blocks: RendererMessageBlock[] = [
      {
        type: 'thinking',
        content: [
          '~~~~text',
          '**code A****code B**',
          '~~~~',
          '**真实摘要 A****真实摘要 B**'
        ].join('\n')
      },
      toolBlock('1', 'read', { path: 'a.ts' })
    ]

    const model = buildTurnRenderModel({
      blocks,
      toolCalls: [],
      mode: 'default',
      phase: 'completed'
    })

    expect(model.summary.thoughtPreview).toBe('真实摘要 A 真实摘要 B')
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
