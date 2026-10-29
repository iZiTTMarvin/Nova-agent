/**
 * turnProcessModel 分区单测
 */
import { describe, expect, it } from 'vitest'
import {
  buildTurnRenderModel,
  normalizeThinkingForDisplay,
  type TurnBuildCache
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

  it('thinking 一律属于过程，与工具一起收进活动组并保留原始 index', () => {
    const blocks: RendererMessageBlock[] = [
      { type: 'thinking', content: '第一段' },
      toolBlock('1', 'ls', { path: '.' }),
      { type: 'thinking', content: '第二段' }
    ]
    const model = buildTurnRenderModel({ blocks, toolCalls: [], mode: 'default', phase: 'live' })
    expect(model.hasProcess).toBe(true)
    expect(model.timeline).toHaveLength(1)
    const group = model.timeline[0]
    expect(group).toMatchObject({ kind: 'activity', display: 'process', isLast: true })
    if (group.kind === 'activity') {
      expect(group.items.at(-1)).toMatchObject({ kind: 'block', index: 2 })
    }
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
      model.timeline.some(s => s.kind === 'tool' && s.block.toolName === 'todo_write')
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

  it('可视化是回合产物：生成中与展示后都外露，失败的调用退回过程轨迹', () => {
    const blocks: RendererMessageBlock[] = [
      { type: 'text', content: '先看结构' },
      toolBlock('v1', 'present_visualization', { title: '架构' }),
      { ...toolBlock('v2', 'present_visualization', { title: '被拒' }), status: 'error' },
      { ...toolBlock('v3', 'present_visualization', { title: '生成中' }), status: 'running' }
    ]
    const model = buildTurnRenderModel({ blocks, toolCalls: [], mode: 'default', phase: 'completed' })
    expect(model.timeline.map(s => [s.kind === 'tool' ? s.block.toolCallId : s.kind, s.display])).toEqual([
      ['block', 'process'],
      ['v1', 'persistent'],
      ['v2', 'process'],
      ['v3', 'persistent']
    ])
    // 可视化本身就是结论，不再补“无结论”占位
    expect(model.missingAnswer).toBe(false)
  })

  it('可视化后的文字仍是答案，可视化卡片不进入折叠区', () => {
    const blocks: RendererMessageBlock[] = [
      toolBlock('1', 'read', { path: 'a.ts' }),
      toolBlock('v1', 'present_visualization', { title: '架构' }),
      { type: 'text', content: '图中红色是热点' }
    ]
    const model = buildTurnRenderModel({ blocks, toolCalls: [], mode: 'default', phase: 'completed' })
    expect(displays(model)).toEqual(['process', 'persistent', 'persistent'])
  })

  it('两段说话之间的思考与各类工具合成一个活动组；说话与交互卡片打断连续段', () => {
    const blocks: RendererMessageBlock[] = [
      { type: 'thinking', content: '先看看' },
      toolBlock('1', 'read', { path: 'a.ts' }),
      toolBlock('2', 'bash', { command: 'npm test' }),
      { type: 'text', content: '测试通过，再看计划' },
      toolBlock('3', 'read', { path: 'b.ts' }),
      toolBlock('q1', 'askQuestion', { questions: [] }),
      toolBlock('4', 'grep', { pattern: 'x' }),
      toolBlock('5', 'edit', { path: 'b.ts' }),
      { type: 'text', content: 'done' }
    ]
    const model = buildTurnRenderModel({ blocks, toolCalls: [], mode: 'default', phase: 'completed' })
    expect(
      model.timeline.map(s =>
        s.kind === 'activity'
          ? `activity:${s.items.length}`
          : s.kind === 'tool'
            ? s.block.toolCallId
            : s.block.type
      )
    ).toEqual(['activity:3', 'text', '3', 'q1', 'activity:2', 'text'])
    expect(model.timeline.filter(s => s.kind === 'activity').map(s => s.kind === 'activity' && s.isLast))
      .toEqual([false, false])
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

  it('无 blocks，有 toolCalls → 降级路径：thinking 与工具属过程并合成活动组，content 是答案', () => {
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
    expect(model.timeline.map(s => [s.kind, s.display])).toEqual([
      ['activity', 'process'],
      ['block', 'persistent']
    ])
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


describe('buildTurnRenderModel 增量缓存', () => {
  function freshCache(mode: 'default' | 'plan' = 'default'): TurnBuildCache {
    return { blocks: [], mode, answerIndex: -1, lastSavePlanIndex: -1, timeline: [], segmentEndBlockIndex: [] }
  }
  function build(blocks: RendererMessageBlock[], cache?: TurnBuildCache) {
    return buildTurnRenderModel({ blocks, toolCalls: [], mode: 'default', phase: 'live', cache })
  }

  it('live 文本尾段增长：增量结果与全量一致，前缀段引用稳定', () => {
    const blocks1: RendererMessageBlock[] = [
      { type: 'thinking', content: '思考' },
      toolBlock('r1', 'read'),
      toolBlock('r2', 'read'),
      { type: 'text', content: '答案第一' }
    ]
    const cache = freshCache()
    const first = build(blocks1, cache)

    const blocks2 = [...blocks1.slice(0, 3), { type: 'text', content: '答案第一段继续增长' }]
    const incremental = build(blocks2, cache)
    const full = build(blocks2)

    expect(incremental.timeline).toEqual(full.timeline)
    // 活动组为同一对象：下游 React.memo 不失效
    expect(incremental.timeline[0]).toMatchObject({ kind: 'activity', isLast: false })
    expect(incremental.timeline[0]).toBe(first.timeline[0])
  })

  it('活动组尾部追加新项：增量结果与全量一致，组身份不变', () => {
    const blocks1: RendererMessageBlock[] = [
      { type: 'thinking', content: '思考' },
      toolBlock('r1', 'read'),
      toolBlock('r2', 'read')
    ]
    const cache = freshCache()
    const first = build(blocks1, cache)

    const blocks2 = [...blocks1, toolBlock('r3', 'bash')]
    const incremental = build(blocks2, cache)
    const full = build(blocks2)

    expect(incremental.timeline).toEqual(full.timeline)
    const [before, after] = [first.timeline[0], incremental.timeline[0]]
    if (before.kind !== 'activity' || after.kind !== 'activity') throw new Error('活动组缺失')
    expect(after.id).toBe(before.id)
    expect(after.items).toHaveLength(4)
    expect(after.items[1].block).toBe(before.items[1].block)
  })

  it('尾部工具状态更新：增量结果与全量一致', () => {
    const blocks1: RendererMessageBlock[] = [
      toolBlock('r1', 'read'),
      { ...toolBlock('r2', 'read'), status: 'running' }
    ]
    const cache = freshCache()
    build(blocks1, cache)

    const blocks2 = [blocks1[0], { ...toolBlock('r2', 'read'), status: 'success' }]
    const incremental = build(blocks2, cache)
    const full = build(blocks2)
    expect(incremental.timeline).toEqual(full.timeline)
  })

  it('可视化生成失败后归入过程：增量结果与全量一致', () => {
    const blocks1: RendererMessageBlock[] = [
      { type: 'thinking', content: '思考' },
      { ...toolBlock('v1', 'present_visualization'), status: 'running' }
    ]
    const cache = freshCache()
    expect(displays(build(blocks1, cache))).toEqual(['process', 'persistent'])

    const blocks2: RendererMessageBlock[] = [blocks1[0], { ...toolBlock('v1', 'present_visualization'), status: 'error' }]
    const incremental = build(blocks2, cache)
    expect(incremental.timeline).toEqual(build(blocks2).timeline)
    // 失败的可视化退回普通轨迹行，与前面的思考收进同一活动组
    expect(incremental.timeline.map(s => [s.kind, s.display])).toEqual([['activity', 'process']])
  })

  it('新增 save_plan 使前缀计划卡隐藏：增量必须与全量一致（不残留旧段）', () => {
    const blocks1: RendererMessageBlock[] = [
      { ...toolBlock('sp1', 'save_plan'), status: 'success' },
      { type: 'text', content: '中间说明' }
    ]
    const cache = freshCache()
    build(blocks1, cache)

    const blocks2 = [...blocks1, toolBlock('sp2', 'save_plan')]
    const incremental = build(blocks2, cache)
    const full = build(blocks2)
    expect(incremental.timeline).toEqual(full.timeline)
  })

  it('尾部 save_plan 失败回退到前缀成功计划卡：增量必须让前缀卡重新可见', () => {
    // sp1 成功 → sp2 进行中（隐藏 sp1）→ sp2 失败（sp1 应恢复展示）
    const blocks1: RendererMessageBlock[] = [
      { ...toolBlock('sp1', 'save_plan'), status: 'success' },
      { type: 'text', content: '中间说明' }
    ]
    const cache = freshCache()
    build(blocks1, cache)

    const blocks2 = [...blocks1, { ...toolBlock('sp2', 'save_plan'), status: 'running' }]
    build(blocks2, cache)

    const blocks3 = [...blocks1, { ...toolBlock('sp2', 'save_plan'), status: 'error' }]
    const incremental = build(blocks3, cache)
    const full = build(blocks3)

    expect(incremental.timeline).toEqual(full.timeline)
    const savePlanSegments = full.timeline.filter(
      s => s.kind === 'tool' && s.block.toolName === 'save_plan'
    )
    expect(savePlanSegments).toHaveLength(1)
  })

  it('追加可见工具剥夺前缀 text 答案资格：display 变化正确传播', () => {
    const blocks1: RendererMessageBlock[] = [
      { type: 'text', content: '先给结论' }
    ]
    const cache = freshCache()
    build(blocks1, cache)

    const blocks2 = [...blocks1, toolBlock('r1', 'read')]
    const incremental = build(blocks2, cache)
    const full = build(blocks2)
    expect(incremental.timeline).toEqual(full.timeline)
    expect(displays(incremental)).toEqual(['process', 'process'])
  })

  it('mode 变化不跨缓存复用', () => {
    const blocks1: RendererMessageBlock[] = [
      toolBlock('w1', 'write'),
      { type: 'text', content: '完成' }
    ]
    const cache = freshCache()
    build(blocks1, cache)

    const incremental = buildTurnRenderModel({ blocks: blocks1, toolCalls: [], mode: 'plan', phase: 'live', cache })
    const full = buildTurnRenderModel({ blocks: blocks1, toolCalls: [], mode: 'plan', phase: 'live' })
    expect(incremental.timeline).toEqual(full.timeline)
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
