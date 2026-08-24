/**
 * turnProcessModel 分区单测
 */
import { describe, expect, it } from 'vitest'
import {
  buildTurnRenderModel,
  normalizeThinkingForDisplay
} from '../../../src/renderer/features/chat/turnProcessModel'
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

function displays(model: { timeline: Array<{ display: string }> }): string[] {
  return model.timeline.map(segment => segment.display)
}

describe('buildTurnRenderModel', () => {
  it('无 tool，仅 text → hasProcess=false，text 为最终答案', () => {
    const blocks: RendererMessageBlock[] = [{ type: 'text', content: '结论全文' }]
    const model = buildTurnRenderModel({ blocks, toolCalls: [], mode: 'default', phase: 'completed' })
    expect(model.hasProcess).toBe(false)
    expect(model.missingAnswer).toBe(false)
    expect(displays(model)).toEqual(['persistent'])
  })

  it('text → tool → text，最后 text 是答案；前 text 是过程备注', () => {
    const blocks: RendererMessageBlock[] = [
      { type: 'text', content: '中间说明' },
      toolBlock('1', 'read', { path: 'a.ts' }),
      { type: 'text', content: '最终结论' }
    ]
    const model = buildTurnRenderModel({ blocks, toolCalls: [], mode: 'default', phase: 'completed' })
    expect(model.hasProcess).toBe(true)
    expect(model.missingAnswer).toBe(false)
    expect(displays(model)).toEqual(['process', 'process', 'persistent'])
    const answer = model.timeline.filter(s => s.display === 'persistent')
    expect(answer).toHaveLength(1)
    if (answer[0].kind === 'block') {
      expect((answer[0].block as { content: string }).content).toBe('最终结论')
    }
  })

  it('tool → text → tool → text，仅最后 text 是答案', () => {
    const blocks: RendererMessageBlock[] = [
      toolBlock('1', 'bash', { command: 'npm test' }),
      { type: 'text', content: '中间' },
      toolBlock('2', 'read', { path: 'b.ts' }),
      { type: 'text', content: '结论' }
    ]
    const model = buildTurnRenderModel({ blocks, toolCalls: [], mode: 'default', phase: 'completed' })
    expect(displays(model)).toEqual(['process', 'process', 'process', 'persistent'])
  })

  it('尾部多段 text：只有最后一段是答案，其余是过程', () => {
    const blocks: RendererMessageBlock[] = [
      toolBlock('1', 'read', { path: 'a.ts' }),
      { type: 'text', content: '进度备注' },
      { type: 'text', content: '结论' }
    ]
    const model = buildTurnRenderModel({ blocks, toolCalls: [], mode: 'default', phase: 'completed' })
    expect(displays(model)).toEqual(['process', 'process', 'persistent'])
  })

  it('尾部空 text 不充当答案也不产生渲染单元', () => {
    const blocks: RendererMessageBlock[] = [
      toolBlock('1', 'read', { path: 'a.ts' }),
      { type: 'text', content: '结论' },
      { type: 'text', content: '  ' }
    ]
    const model = buildTurnRenderModel({ blocks, toolCalls: [], mode: 'default', phase: 'completed' })
    expect(displays(model)).toEqual(['process', 'persistent'])
    const answer = model.timeline.filter(s => s.display === 'persistent')
    if (answer[0].kind === 'block') {
      expect((answer[0].block as { content: string }).content).toBe('结论')
    }
  })

  it('thinking 一律属于过程，即使位于工具之后也保留原始 index', () => {
    const blocks: RendererMessageBlock[] = [
      { type: 'thinking', content: '第一段' },
      toolBlock('1', 'ls', { path: '.' }),
      { type: 'thinking', content: '第二段' }
    ]
    const model = buildTurnRenderModel({ blocks, toolCalls: [], mode: 'default', phase: 'live' })
    expect(model.hasProcess).toBe(true)
    expect(model.timeline.every(segment => segment.display === 'process')).toBe(true)
    const tail = model.timeline.at(-1)
    expect(tail).toMatchObject({ kind: 'block', index: 2 })
  })

  it('工具后无 text 的 completed 轮次标记 missingAnswer；live 不标记', () => {
    const blocks: RendererMessageBlock[] = [
      { type: 'thinking', content: '分析中' },
      toolBlock('1', 'bash', { command: 'npm test' })
    ]
    const completed = buildTurnRenderModel({ blocks, toolCalls: [], mode: 'default', phase: 'completed' })
    expect(completed.hasProcess).toBe(true)
    expect(completed.missingAnswer).toBe(true)
    const live = buildTurnRenderModel({ blocks, toolCalls: [], mode: 'default', phase: 'live' })
    expect(live.missingAnswer).toBe(false)
  })

  it('todo_write 由顶部面板统一展示，不进入时间线', () => {
    const blocks: RendererMessageBlock[] = [
      toolBlock('t1', 'todo_write', { todos: [] }),
      toolBlock('1', 'read', { path: 'a.ts' }),
      { type: 'text', content: 'done' }
    ]
    const model = buildTurnRenderModel({ blocks, toolCalls: [], mode: 'default', phase: 'completed' })
    expect(
      model.timeline.some(
        s =>
          (s.kind === 'tool' && s.block.toolName === 'todo_write') ||
          (s.kind === 'toolGroup' && s.toolName === 'todo_write')
      )
    ).toBe(false)
    expect(displays(model)).toEqual(['process', 'persistent'])
  })

  it('askQuestion 属于工作过程：问答卡随过程折叠，不外露为答案', () => {
    const blocks: RendererMessageBlock[] = [
      { type: 'text', content: '我将询问你' },
      toolBlock('q1', 'askQuestion', { questions: [{ question: 'Q1', options: [{ label: 'A' }] }] })
    ]
    const model = buildTurnRenderModel({ blocks, toolCalls: [], mode: 'default', phase: 'completed' })
    expect(model.timeline.every(segment => segment.display === 'process')).toBe(true)
    expect(model.missingAnswer).toBe(true)
  })

  it('ask 落在后续可见工具之前同样进入过程', () => {
    const blocks: RendererMessageBlock[] = [
      { type: 'text', content: '先问' },
      toolBlock('q1', 'askQuestion', { questions: [] }),
      toolBlock('1', 'read', { path: 'a.ts' }),
      { type: 'text', content: 'done' }
    ]
    const model = buildTurnRenderModel({ blocks, toolCalls: [], mode: 'default', phase: 'completed' })
    expect(model.timeline.some(s => s.kind === 'tool' && s.block.toolName === 'askQuestion')).toBe(true)
    expect(displays(model)).toEqual(['process', 'process', 'process', 'persistent'])
  })

  it('连续 read×3 → 过程时间线含 toolGroup', () => {
    const blocks: RendererMessageBlock[] = [
      toolBlock('1', 'read', { path: 'a.ts' }),
      toolBlock('2', 'read', { path: 'b.ts' }),
      toolBlock('3', 'read', { path: 'c.ts' }),
      { type: 'text', content: 'done' }
    ]
    const model = buildTurnRenderModel({ blocks, toolCalls: [], mode: 'default', phase: 'completed' })
    expect(model.timeline.some(s => s.kind === 'toolGroup')).toBe(true)
  })

  it('plan 模式隐藏 write：write 不参与答案边界，也不产生渲染单元', () => {
    const blocks: RendererMessageBlock[] = [
      toolBlock('r1', 'read', { path: 'a.ts' }),
      toolBlock('w1', 'write', { path: 'hidden.ts', content: 'x' }),
      { type: 'text', content: '仅文本' }
    ]
    const model = buildTurnRenderModel({ blocks, toolCalls: [], mode: 'plan', phase: 'completed' })
    expect(model.hasProcess).toBe(true)
    expect(displays(model)).toEqual(['process', 'persistent'])
    const answer = model.timeline.filter(s => s.display === 'persistent')
    expect(answer).toHaveLength(1)
    if (answer[0].kind === 'block') {
      expect((answer[0].block as { content: string }).content).toBe('仅文本')
    }
  })

  it('计划说明、save_plan、审批控制工具与实施工具均属过程，仅最终 text 外露', () => {
    const blocks: RendererMessageBlock[] = [
      toolBlock('1', 'read', { path: 'a.ts' }),
      { type: 'text', content: '这是计划说明' },
      toolBlock('p1', 'save_plan', { title: '计划', content: '正文' }),
      toolBlock('m1', 'switch_mode', { mode: 'default', reason: '开始实施' }),
      toolBlock('2', 'edit', { path: 'a.ts' }),
      { type: 'text', content: '收尾' }
    ]
    const model = buildTurnRenderModel({ blocks, toolCalls: [], mode: 'default', phase: 'completed' })

    expect(model.timeline.map(segment => [segment.kind, segment.display])).toEqual([
      ['tool', 'process'],
      ['block', 'process'],
      ['tool', 'process'],
      ['tool', 'process'],
      ['tool', 'process'],
      ['block', 'persistent']
    ])
  })

  it('同一 message 多次保存计划时只投影最后一张计划卡', () => {
    const blocks: RendererMessageBlock[] = [
      toolBlock('p1', 'save_plan', { title: '计划', content: '旧正文' }),
      { type: 'text', content: '根据意见修订' },
      toolBlock('p2', 'save_plan', { title: '计划', content: '新正文' })
    ]
    const model = buildTurnRenderModel({ blocks, toolCalls: [], mode: 'plan', phase: 'live' })
    const plans = model.timeline.filter(
      segment => segment.kind === 'tool' && segment.block.toolName === 'save_plan'
    )
    expect(plans).toHaveLength(1)
    if (plans[0]?.kind === 'tool') expect(plans[0].block.toolCallId).toBe('p2')
  })

  it('最后一次 save_plan 失败时回退到上一张成功计划卡', () => {
    const blocks: RendererMessageBlock[] = [
      toolBlock('p1', 'save_plan', { title: '计划', content: '旧正文' }),
      { type: 'text', content: '尝试修订' },
      { ...toolBlock('p2', 'save_plan', { title: '计划', content: '新正文' }), status: 'error' }
    ]
    const model = buildTurnRenderModel({ blocks, toolCalls: [], mode: 'plan', phase: 'completed' })
    const plans = model.timeline.filter(
      segment => segment.kind === 'tool' && segment.block.toolName === 'save_plan'
    )
    expect(plans).toHaveLength(1)
    if (plans[0]?.kind === 'tool') expect(plans[0].block.toolCallId).toBe('p1')
  })

  it('无 blocks，有 toolCalls → 降级路径：thinking 与工具属过程，content 是答案', () => {
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
    expect(model.missingAnswer).toBe(false)
    expect(displays(model)).toEqual(['process', 'process', 'persistent'])
  })

  it('降级路径无 content 时同样标记 missingAnswer', () => {
    const toolCalls: ExtendedToolCall[] = [
      { id: '1', name: 'read', arguments: { path: 'a.ts' }, status: 'success' }
    ]
    const model = buildTurnRenderModel({
      blocks: undefined,
      toolCalls,
      mode: 'default',
      phase: 'completed'
    })
    expect(model.hasProcess).toBe(true)
    expect(model.missingAnswer).toBe(true)
  })

  it('completed 有起止点时带时长；旧消息缺字段则不带', () => {
    const blocks: RendererMessageBlock[] = [
      toolBlock('1', 'read', { path: 'a.ts' }),
      { type: 'text', content: '结论' }
    ]
    expect(
      buildTurnRenderModel({
        blocks,
        toolCalls: [],
        mode: 'default',
        phase: 'completed',
        turnStartedAt: 1_000,
        turnEndedAt: 98_000
      }).durationMs
    ).toBe(97_000)
    expect(
      buildTurnRenderModel({
        blocks,
        toolCalls: [],
        mode: 'default',
        phase: 'completed'
      }).durationMs
    ).toBeUndefined()
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
})
