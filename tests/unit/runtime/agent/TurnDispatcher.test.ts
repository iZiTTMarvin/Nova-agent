/**
 * TurnDispatcher 单测：锁定"分派器只返回数据、不拥有生命周期"的边界。
 *
 * - 每种 route 都调用且仅调用对应执行器，参数原样透传；
 * - 执行器抛错原样向上传播（终态归 AgentLoop finalizer，dispatcher 不吞错、不转译）；
 * - route 与执行器不匹配时 fail closed；
 * - agent 路径把 inject / system_notice / passthrough 规范化为声明式 continue 结果；
 * - dispatcher 构造依赖中没有 EventBus / CheckpointManager，结构上不可能发终态事件
 *   或操作 checkpoint，测试以"返回值为纯数据"锁定该契约。
 */
import { describe, expect, it, vi } from 'vitest'
import { TurnDispatcher, type TurnDispatchContext } from '../../../../src/runtime/agent/turn'
import type { SkillManifest } from '../../../../src/runtime/skills/types'
import type { ContentBlock } from '../../../../src/runtime/model/types'

function dispatchCtx(overrides: Partial<TurnDispatchContext> = {}): TurnDispatchContext {
  return {
    messageId: 'msg-1',
    abortSignal: undefined,
    fork: {
      workingDir: '/ws',
      workspacePath: '/ws'
    },
    ...overrides
  }
}

const forkSkill = { name: 'f', directory: '/skills/f', body: 'do it' } as unknown as SkillManifest

describe('TurnDispatcher 产品路径（handled）', () => {
  it('skill_fork route → 调用 skillForkRunner，fork ctx 与 templateContext 来自分派上下文', async () => {
    const runner = vi.fn(async () => ({ success: true, summary: 'fork done' }))
    const dispatcher = new TurnDispatcher({ skillForkRunner: runner })
    const ctx = dispatchCtx()

    const outcome = await dispatcher.dispatch(
      '/f 参数',
      { kind: 'skill_fork', skill: forkSkill, args: '参数' },
      ctx
    )

    expect(outcome).toEqual({ kind: 'handled', assistantSummary: 'fork done' })
    expect(runner).toHaveBeenCalledWith({
      skill: forkSkill,
      args: '参数',
      ctx: {
        workingDir: '/ws',
        messageId: 'msg-1'
      },
      templateContext: { workspacePath: '/ws' }
    })
  })

  it('fork 执行失败（success=false）时摘要仍作为 handled 返回，不转译为异常', async () => {
    const dispatcher = new TurnDispatcher({
      skillForkRunner: async () => ({ success: false, summary: '子代理执行出错' })
    })

    const outcome = await dispatcher.dispatch(
      '/f',
      { kind: 'skill_fork', skill: forkSkill, args: '' },
      dispatchCtx()
    )

    expect(outcome).toEqual({ kind: 'handled', assistantSummary: '子代理执行出错' })
  })
})

describe('TurnDispatcher 执行器抛错原样传播', () => {
  it.each([
    ['skill_fork', new TurnDispatcher({ skillForkRunner: async () => { throw new Error('fork boom') } }),
      { kind: 'skill_fork' as const, skill: forkSkill, args: '' }, 'fork boom']
  ])('%s 执行器抛错 → dispatch 原样 reject，不吞错', async (_name, dispatcher, route, message) => {
    await expect(dispatcher.dispatch('x', route, dispatchCtx())).rejects.toThrow(message)
  })
})

describe('TurnDispatcher 能力断言（fail closed）', () => {
  it.each([
    [{ kind: 'skill_fork' as const, skill: forkSkill, args: '' }, /skillForkRunner/]
  ])('缺少执行器时 assertRouteExecutable 与 dispatch 都抛错', async (route, pattern) => {
    const dispatcher = new TurnDispatcher({})
    expect(() => dispatcher.assertRouteExecutable(route)).toThrow(pattern)
    await expect(dispatcher.dispatch('x', route, dispatchCtx())).rejects.toThrow(pattern)
  })

  it('agent route 不需要任何执行器', () => {
    const dispatcher = new TurnDispatcher({})
    expect(() =>
      dispatcher.assertRouteExecutable({ kind: 'agent', dispatch: { kind: 'passthrough' } })
    ).not.toThrow()
  })
})

describe('TurnDispatcher agent 路径规范化（continue）', () => {
  it('passthrough：字符串输入原样返回', async () => {
    const dispatcher = new TurnDispatcher({})
    const outcome = await dispatcher.dispatch(
      '你好',
      { kind: 'agent', dispatch: { kind: 'passthrough' } },
      dispatchCtx()
    )
    expect(outcome).toEqual({ kind: 'continue', userContent: '你好', userText: '你好' })
  })

  it('passthrough：ContentBlock[] 原样返回，userText 提取文本', async () => {
    const dispatcher = new TurnDispatcher({})
    const blocks: ContentBlock[] = [
      { type: 'text', text: '看图' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,x' } }
    ]
    const outcome = await dispatcher.dispatch(
      blocks,
      { kind: 'agent', dispatch: { kind: 'passthrough' } },
      dispatchCtx()
    )
    expect(outcome.kind).toBe('continue')
    if (outcome.kind === 'continue') {
      expect(outcome.userContent).toBe(blocks)
      expect(outcome.userText).toBe('看图')
    }
  })

  it('inject：返回 assistantPrelude / userContent / grantedSkillRoot', async () => {
    const dispatcher = new TurnDispatcher({})
    const outcome = await dispatcher.dispatch(
      '/sk 干活',
      {
        kind: 'agent',
        dispatch: {
          kind: 'inject',
          assistantContent: '技能正文',
          userContent: '请按上述技能指令执行。',
          skillDirectory: '/skills/sk'
        }
      },
      dispatchCtx()
    )
    expect(outcome).toEqual({
      kind: 'continue',
      userContent: '请按上述技能指令执行。',
      userText: '请按上述技能指令执行。',
      assistantPrelude: '技能正文',
      grantedSkillRoot: '/skills/sk'
    })
  })

  it('inject 无 skillDirectory 时不产生 grantedSkillRoot', async () => {
    const dispatcher = new TurnDispatcher({})
    const outcome = await dispatcher.dispatch(
      '/sk',
      {
        kind: 'agent',
        dispatch: { kind: 'inject', assistantContent: 'a', userContent: 'u' }
      },
      dispatchCtx()
    )
    expect(outcome.kind).toBe('continue')
    if (outcome.kind === 'continue') {
      expect('grantedSkillRoot' in outcome).toBe(false)
    }
  })

  it('system_notice：通知文本作为 userContent/userText', async () => {
    const dispatcher = new TurnDispatcher({})
    const outcome = await dispatcher.dispatch(
      '/none',
      { kind: 'agent', dispatch: { kind: 'system_notice', text: '[系统提示] 无法调用技能' } },
      dispatchCtx()
    )
    expect(outcome).toEqual({
      kind: 'continue',
      userContent: '[系统提示] 无法调用技能',
      userText: '[系统提示] 无法调用技能'
    })
  })
})
