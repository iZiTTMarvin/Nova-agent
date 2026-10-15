import { describe, expect, it, beforeEach, vi } from 'vitest'
import {
  StopPolicyExtension,
  EMPTY_ARGS_LIMIT,
  NO_PROGRESS_ROUND_LIMIT,
  REPEATED_FAILURE_LIMIT,
  REPEATED_SUCCESS_LIMIT
} from '../../../../src/runtime/agent/extensions/stopPolicyExtension'
import type { ShouldStopArgs } from '../../../../src/runtime/agent/core/loopTypes'

function makeArgs(
  partial: Partial<ShouldStopArgs> & Pick<ShouldStopArgs, 'toolCallsThisRound' | 'outcomes'>
): ShouldStopArgs {
  return {
    messageId: 'msg_1',
    toolRound: 1,
    maxToolRounds: 20,
    ...partial
  }
}

describe('StopPolicyExtension — 连续空参护栏', () => {
  let policy: StopPolicyExtension

  beforeEach(() => {
    policy = new StopPolicyExtension()
  })

  const emptyFailedRound = (toolName = 'grep') => ({
    toolCallsThisRound: [{ name: toolName, args: {} }],
    outcomes: [{
      toolCall: { id: 'tc1', name: toolName },
      args: {},
      resultText: '错误',
      failed: true
    }]
  })

  it(`连续 ${EMPTY_ARGS_LIMIT} 轮全空参先注入恢复指令，引导后仍空参才停止`, async () => {
    const first = await policy.shouldStopAfterTurn(makeArgs({ ...emptyFailedRound(), toolRound: 1 }))
    expect(first).toBeUndefined()

    const guidance = await policy.shouldStopAfterTurn(makeArgs({ ...emptyFailedRound(), toolRound: 2 }))
    expect(guidance).toMatchObject({ stop: false })
    expect(guidance?.instruction).toContain('empty arguments')

    const stopped = await policy.shouldStopAfterTurn(makeArgs({ ...emptyFailedRound(), toolRound: 3 }))
    expect(stopped).toMatchObject({ stop: true, reason: 'empty_args' })
    expect(stopped?.notice).toContain('XML 兼容模式')
  })

  it('引导后模型补全参数 → 不中断，引导状态一并复位', async () => {
    await policy.shouldStopAfterTurn(makeArgs({ ...emptyFailedRound('grep'), toolRound: 1 }))
    const guidance = await policy.shouldStopAfterTurn(makeArgs({ ...emptyFailedRound('grep'), toolRound: 2 }))
    expect(guidance).toMatchObject({ stop: false })

    const recoveredRound = {
      toolCallsThisRound: [{ name: 'grep', args: { pattern: 'foo' } }],
      outcomes: [{
        toolCall: { id: 'tc2', name: 'grep' },
        args: { pattern: 'foo' },
        resultText: 'ok',
        failed: false
      }]
    }
    const recovered = await policy.shouldStopAfterTurn(makeArgs({ ...recoveredRound, toolRound: 3 }))
    expect(recovered).toBeUndefined()

    // 复位后重新累计：再次两轮空参开启新的引导周期，而不是直接熔断。
    // 换工具避免同签名重复失败熔断先行介入，此处只验证空参护栏自身语义。
    await policy.shouldStopAfterTurn(makeArgs({ ...emptyFailedRound('find'), toolRound: 4 }))
    const secondCycle = await policy.shouldStopAfterTurn(makeArgs({ ...emptyFailedRound('find'), toolRound: 5 }))
    expect(secondCycle).toMatchObject({ stop: false })
  })

  it('中间出现非空参 → 计数清零，不触发', async () => {
    await policy.shouldStopAfterTurn(makeArgs({ ...emptyFailedRound(), toolRound: 1 }))

    const nonEmptyRound = {
      toolCallsThisRound: [{ name: 'grep', args: { pattern: 'foo' } }],
      outcomes: [{
        toolCall: { id: 'tc2', name: 'grep' },
        args: { pattern: 'foo' },
        resultText: 'ok',
        failed: true
      }]
    }
    await policy.shouldStopAfterTurn(makeArgs({ ...nonEmptyRound, toolRound: 2 }))

    const third = await policy.shouldStopAfterTurn(makeArgs({ ...emptyFailedRound(), toolRound: 3 }))
    expect(third).toBeUndefined()
  })

  it('中间出现成功执行 → 计数清零', async () => {
    await policy.shouldStopAfterTurn(makeArgs({ ...emptyFailedRound(), toolRound: 1 }))

    const successRound = {
      toolCallsThisRound: [{ name: 'grep', args: {} }],
      outcomes: [{
        toolCall: { id: 'tc2', name: 'grep' },
        args: {},
        resultText: 'ok',
        failed: false
      }]
    }
    await policy.shouldStopAfterTurn(makeArgs({ ...successRound, toolRound: 2 }))

    const third = await policy.shouldStopAfterTurn(makeArgs({ ...emptyFailedRound(), toolRound: 3 }))
    expect(third).toBeUndefined()
  })

  it('clear() 重置空参计数与引导状态', async () => {
    const round = emptyFailedRound('read')

    await policy.shouldStopAfterTurn(makeArgs({ ...round, toolRound: 1 }))
    const guidance = await policy.shouldStopAfterTurn(makeArgs({ ...round, toolRound: 2 }))
    expect(guidance).toMatchObject({ stop: false })

    policy.clear()

    const again = await policy.shouldStopAfterTurn(makeArgs({ ...round, toolRound: 1 }))
    expect(again).toBeUndefined()
    const reGuided = await policy.shouldStopAfterTurn(makeArgs({ ...round, toolRound: 2 }))
    expect(reGuided).toMatchObject({ stop: false })
  })

  it('空参引导不越过工具轮数硬上限', async () => {
    await policy.shouldStopAfterTurn(makeArgs({ ...emptyFailedRound(), toolRound: 1, maxToolRounds: 2 }))
    const result = await policy.shouldStopAfterTurn(
      makeArgs({ ...emptyFailedRound(), toolRound: 2, maxToolRounds: 2 })
    )

    expect(result).toMatchObject({ stop: true, reason: 'max_rounds' })
  })

  it('成功进入 default 后不结束任务，由 AgentLoop 按新模式继续', async () => {
    const result = await policy.shouldStopAfterTurn(makeArgs({
      toolCallsThisRound: [{ name: 'switch_mode', args: { mode: 'default' } }],
      outcomes: [{
        toolCall: { id: 'switch-1', name: 'switch_mode' },
        args: { mode: 'default' },
        resultText: 'ok',
        failed: false
      }]
    }))

    expect(result).toBeUndefined()
  })

  it('成功进入 plan 后不结束任务，由 AgentLoop 按新模式继续', async () => {
    const result = await policy.shouldStopAfterTurn(makeArgs({
      toolCallsThisRound: [{ name: 'switch_mode', args: { mode: 'plan' } }],
      outcomes: [{
        toolCall: { id: 'switch-2', name: 'switch_mode' },
        args: { mode: 'plan' },
        resultText: 'ok',
        failed: false
      }]
    }))

    expect(result).toBeUndefined()
  })

  it('switch_mode 同模式 no-op 不应被当作真实模式切换屏障', async () => {
    const result = await policy.shouldStopAfterTurn(makeArgs({
      toolCallsThisRound: [{ name: 'switch_mode', args: { mode: 'default' } }],
      outcomes: [{
        toolCall: { id: 'switch-noop', name: 'switch_mode' },
        args: { mode: 'default' },
        resultText: '当前已经是 default 模式。',
        failed: false
      }]
    }))

    expect(result).toBeUndefined()
  })
})

describe('StopPolicyExtension — 重复失败恢复', () => {
  let policy: StopPolicyExtension

  beforeEach(() => {
    policy = new StopPolicyExtension()
  })

  const failedRound = (args: Record<string, unknown>) => ({
    toolCallsThisRound: [{ name: 'read', args }],
    outcomes: [{
      toolCall: { id: 'tc', name: 'read' },
      args,
      resultText: 'not found',
      failed: true
    }]
  })

  it(`连续 ${REPEATED_FAILURE_LIMIT} 次等价失败先要求改变路径，再重复才停止`, async () => {
    const firstArgs = { path: 'missing.ts', options: { offset: 1, limit: 20 } }
    const reorderedArgs = { options: { limit: 20, offset: 1 }, path: 'missing.ts' }

    await policy.shouldStopAfterTurn(makeArgs(failedRound(firstArgs)))
    await policy.shouldStopAfterTurn(makeArgs(failedRound(reorderedArgs)))
    const recovery = await policy.shouldStopAfterTurn(makeArgs(failedRound(firstArgs)))

    expect(recovery).toMatchObject({ stop: false })
    expect(recovery?.instruction).toContain('different approach')

    const stopped = await policy.shouldStopAfterTurn(makeArgs(failedRound(reorderedArgs)))
    expect(stopped).toMatchObject({ stop: true, reason: 'breaker' })
  })

  it('不同失败签名独立累计，切换调用不会抹掉既有失败证据', async () => {
    const first = failedRound({ path: 'first.ts' })
    const second = failedRound({ path: 'second.ts' })

    await policy.shouldStopAfterTurn(makeArgs(first))
    await policy.shouldStopAfterTurn(makeArgs(first))
    await policy.shouldStopAfterTurn(makeArgs(second))
    const recovery = await policy.shouldStopAfterTurn(makeArgs(first))
    const stopped = await policy.shouldStopAfterTurn(makeArgs(first))

    expect(recovery).toMatchObject({ stop: false })
    expect(stopped).toMatchObject({ stop: true, reason: 'breaker' })
  })

  it('同批次的无关成功调用不会重置失败签名', async () => {
    const mixedRound = {
      toolCallsThisRound: [
        { name: 'read', args: { path: 'missing.ts' } },
        { name: 'ls', args: { path: '.' } }
      ],
      outcomes: [
        {
          toolCall: { id: 'read-tc', name: 'read' },
          args: { path: 'missing.ts' },
          resultText: 'not found',
          failed: true
        },
        {
          toolCall: { id: 'ls-tc', name: 'ls' },
          args: { path: '.' },
          resultText: 'ok',
          failed: false
        }
      ]
    }

    await policy.shouldStopAfterTurn(makeArgs(mixedRound))
    await policy.shouldStopAfterTurn(makeArgs(mixedRound))
    const recovery = await policy.shouldStopAfterTurn(makeArgs(mixedRound))
    const stopped = await policy.shouldStopAfterTurn(makeArgs(mixedRound))

    expect(recovery).toMatchObject({ stop: false })
    expect(stopped).toMatchObject({ stop: true, reason: 'breaker' })
  })

  it('同一签名成功后清空该签名的失败计数', async () => {
    const round = failedRound({ path: 'eventually-present.ts' })
    await policy.shouldStopAfterTurn(makeArgs(round))
    await policy.shouldStopAfterTurn(makeArgs(round))

    await policy.shouldStopAfterTurn(makeArgs({
      toolCallsThisRound: [{ name: 'read', args: { path: 'eventually-present.ts' } }],
      outcomes: [{
        toolCall: { id: 'success-tc', name: 'read' },
        args: { path: 'eventually-present.ts' },
        resultText: 'ok',
        failed: false
      }]
    }))

    await policy.shouldStopAfterTurn(makeArgs(round))
    const result = await policy.shouldStopAfterTurn(makeArgs(round))
    expect(result).toBeUndefined()
  })

  it('同批次多次命中阈值时仍先给模型一次恢复机会', async () => {
    const args = { path: 'missing.ts' }
    const round = failedRound(args)
    await policy.shouldStopAfterTurn(makeArgs(round))
    await policy.shouldStopAfterTurn(makeArgs(round))

    const recovery = await policy.shouldStopAfterTurn(makeArgs({
      toolCallsThisRound: [
        { name: 'read', args },
        { name: 'read', args }
      ],
      outcomes: [
        { ...round.outcomes[0], toolCall: { id: 'tc-a', name: 'read' } },
        { ...round.outcomes[0], toolCall: { id: 'tc-b', name: 'read' } }
      ]
    }))
    const stopped = await policy.shouldStopAfterTurn(makeArgs(round))

    expect(recovery).toMatchObject({ stop: false })
    expect(stopped).toMatchObject({ stop: true, reason: 'breaker' })
  })

  it('恢复提示不会越过工具轮数硬上限', async () => {
    const round = failedRound({ path: 'missing.ts' })

    await policy.shouldStopAfterTurn(makeArgs({ ...round, toolRound: 1, maxToolRounds: 3 }))
    await policy.shouldStopAfterTurn(makeArgs({ ...round, toolRound: 2, maxToolRounds: 3 }))
    const result = await policy.shouldStopAfterTurn(
      makeArgs({ ...round, toolRound: 3, maxToolRounds: 3 })
    )

    expect(result).toMatchObject({ stop: true, reason: 'max_rounds' })
  })
})

describe('StopPolicyExtension — 循环检测', () => {
  /** 主会话没有轮数上限，断言的是循环检测本身而不是硬上限 */
  const unlimited = { maxToolRounds: null }

  const successRound = (name: string, args: Record<string, unknown>) => ({
    toolCallsThisRound: [{ name, args }],
    outcomes: [{
      toolCall: { id: `tc-${name}-${JSON.stringify(args)}`, name },
      args,
      resultText: 'ok',
      failed: false
    }]
  })

  /** 连续跑同一成功签名直到首次命中循环检测，返回最后一条决定 */
  async function repeatUntilHit(policy: StopPolicyExtension, rounds = REPEATED_SUCCESS_LIMIT + 6) {
    let last: Awaited<ReturnType<StopPolicyExtension['shouldStopAfterTurn']>>
    for (let round = 1; round <= rounds; round += 1) {
      last = await policy.shouldStopAfterTurn(
        makeArgs({ ...successRound('read', { path: 'same.ts' }), toolRound: round, ...unlimited })
      )
      if (last) return { decision: last, round }
    }
    throw new Error('循环检测未命中')
  }

  it('反复重复同一成功调用：先注入换路径指令，再命中才请用户裁决', async () => {
    const adjudicate = vi.fn().mockResolvedValue('redirect' as const)
    const policy = new StopPolicyExtension({ adjudicateNoProgress: adjudicate })

    const { decision } = await repeatUntilHit(policy)
    expect(decision).toMatchObject({ stop: false })
    expect(decision?.instruction).toContain('different step')
    expect(adjudicate).not.toHaveBeenCalled()

    const second = await policy.shouldStopAfterTurn(
      makeArgs({ ...successRound('read', { path: 'same.ts' }), toolRound: 99, ...unlimited })
    )
    expect(adjudicate).toHaveBeenCalledTimes(1)
    expect(second).toMatchObject({ stop: false })
    expect(second?.instruction).toContain('different step')
  })

  it('没有裁决通道时（子代理 / headless）命中两次即 no_progress 停止', async () => {
    const policy = new StopPolicyExtension({ audience: 'subagent' })
    await repeatUntilHit(policy)

    const stopped = await policy.shouldStopAfterTurn(
      makeArgs({ ...successRound('read', { path: 'same.ts' }), toolRound: 99, ...unlimited })
    )
    expect(stopped).toMatchObject({ stop: true, reason: 'no_progress' })
    expect(stopped?.notice).not.toContain('发送「继续」')
  })

  it(`连续 ${NO_PROGRESS_ROUND_LIMIT} 轮没有新进展才判定停滞`, async () => {
    const adjudicate = vi.fn().mockResolvedValue('redirect' as const)
    const policy = new StopPolicyExtension({ adjudicateNoProgress: adjudicate })
    // 两个已知签名轮流提交：既不是新进展，也不会累积成单一签名重复
    const alternating = (round: number) => successRound(round % 2 === 0 ? 'read' : 'grep', { path: 'a.ts' })
    const feed = (round: number) => policy.shouldStopAfterTurn(makeArgs({ ...alternating(round), toolRound: round, ...unlimited }))

    await feed(1)
    await feed(2)
    for (let round = 3; round <= NO_PROGRESS_ROUND_LIMIT + 1; round += 1) {
      const decision = await feed(round)
      expect(decision, `第 ${round} 轮不应判定停滞`).toBeUndefined()
    }

    const stalled = await feed(NO_PROGRESS_ROUND_LIMIT + 2)
    expect(stalled).toMatchObject({ stop: false })
    expect(stalled?.instruction).toContain('no new')
  })

  it('不同参数的失败调用计入停滞窗口，先引导再由用户停止', async () => {
    const policy = new StopPolicyExtension({ adjudicateNoProgress: async () => 'stop' })
    const feed = (round: number) => {
      const failed = successRound('read', { path: `missing-${round}.ts` })
      failed.outcomes[0].failed = true
      return policy.shouldStopAfterTurn(makeArgs({ ...failed, toolRound: round, ...unlimited }))
    }
    for (let round = 1; round < NO_PROGRESS_ROUND_LIMIT; round++) {
      expect(await feed(round)).toBeUndefined()
    }
    expect(await feed(NO_PROGRESS_ROUND_LIMIT)).toMatchObject({ stop: false, instruction: expect.stringContaining('no new') })
    expect(await feed(NO_PROGRESS_ROUND_LIMIT + 1)).toMatchObject({ stop: true, reason: 'no_progress' })
  })

  it('等待失败不推进窗口，随后新的成功调用重置此前失败窗口', async () => {
    const policy = new StopPolicyExtension({ isProgressNeutralTool: name => name === 'task_wait' })
    for (let round = 1; round < NO_PROGRESS_ROUND_LIMIT; round++) {
      const failed = successRound('read', { path: `missing-${round}.ts` })
      failed.outcomes[0].failed = true
      expect(await policy.shouldStopAfterTurn(makeArgs({ ...failed, toolRound: round, ...unlimited }))).toBeUndefined()
    }
    const waiting = successRound('task_wait', { all_unfinished: true })
    waiting.outcomes[0].failed = true
    expect(await policy.shouldStopAfterTurn(makeArgs({ ...waiting, ...unlimited }))).toBeUndefined()
    expect(await policy.shouldStopAfterTurn(makeArgs({ ...successRound('read', { path: 'exists.ts' }), ...unlimited }))).toBeUndefined()
    const failed = successRound('read', { path: 'still-missing.ts' })
    failed.outcomes[0].failed = true
    expect(await policy.shouldStopAfterTurn(makeArgs({ ...failed, ...unlimited }))).toBeUndefined()
  })

  it('等待类调用既不推进无进展窗口，也不算作进展', async () => {
    const adjudicate = vi.fn().mockResolvedValue('redirect' as const)
    const policy = new StopPolicyExtension({
      adjudicateNoProgress: adjudicate,
      isProgressNeutralTool: name => name === 'task_wait'
    })
    // 先做出一次真实进展，之后整轮都是等待：窗口不应推进
    await policy.shouldStopAfterTurn(makeArgs({ ...successRound('grep', { pattern: 'x' }), toolRound: 1, ...unlimited }))
    for (let round = 2; round <= NO_PROGRESS_ROUND_LIMIT + 10; round += 1) {
      const decision = await policy.shouldStopAfterTurn(
        makeArgs({ ...successRound('task_wait', { all_unfinished: true }), toolRound: round, ...unlimited })
      )
      expect(decision, `等待第 ${round} 轮不应命中检测`).toBeUndefined()
    }
    expect(adjudicate).not.toHaveBeenCalled()
  })

  it('用户选「本轮不再提醒」后不再打断', async () => {
    const adjudicate = vi.fn().mockResolvedValue('silence' as const)
    const policy = new StopPolicyExtension({ adjudicateNoProgress: adjudicate })
    await repeatUntilHit(policy)

    expect(
      await policy.shouldStopAfterTurn(makeArgs({ ...successRound('read', { path: 'same.ts' }), toolRound: 99, ...unlimited }))
    ).toBeUndefined()

    // 之后继续重复 30 轮也不再命中
    for (let round = 100; round < 130; round += 1) {
      const decision = await policy.shouldStopAfterTurn(
        makeArgs({ ...successRound('read', { path: 'same.ts' }), toolRound: round, ...unlimited })
      )
      expect(decision?.stop).not.toBe(true)
    }
    expect(adjudicate).toHaveBeenCalledTimes(1)
  })

  it('用户选停止时以 no_progress 结束', async () => {
    const adjudicate = vi.fn().mockResolvedValue('stop' as const)
    const policy = new StopPolicyExtension({ adjudicateNoProgress: adjudicate })
    await repeatUntilHit(policy)

    const stopped = await policy.shouldStopAfterTurn(
      makeArgs({ ...successRound('read', { path: 'same.ts' }), toolRound: 99, ...unlimited })
    )
    expect(stopped).toMatchObject({ stop: true, reason: 'no_progress' })
    expect(stopped?.notice).toContain('发送「继续」')
  })

  it('有真实进展时不触发循环检测，长期任务得以继续', async () => {
    const policy = new StopPolicyExtension()
    for (let round = 1; round <= 130; round += 1) {
      const decision = await policy.shouldStopAfterTurn(
        makeArgs({ ...successRound('read', { path: `file-${round}.ts` }), toolRound: round, ...unlimited })
      )
      // 第 100 轮只注入自检指令，不停止
      if (round === 100) {
        expect(decision).toMatchObject({ stop: false })
        expect(decision?.instruction).toContain('100 tool rounds')
        continue
      }
      expect(decision, `第 ${round} 轮不应被循环检测拦下`).toBeUndefined()
    }
  })
})

describe('StopPolicyExtension — subagent 受众文案', () => {
  // 三条停止路径的判定与 primary 完全一致，仅文案不同：
  // 子代理的停止通知会成为父代理读到的摘要，不得包含面向人类的操作指引。
  let policy: StopPolicyExtension

  beforeEach(() => {
    policy = new StopPolicyExtension({ audience: 'subagent' })
  })

  const successfulRound = {
    toolCallsThisRound: [{ name: 'grep', args: { pattern: 'x' } }],
    outcomes: [{
      toolCall: { id: 'tc', name: 'grep' },
      args: { pattern: 'x' },
      resultText: 'ok',
      failed: false
    }]
  }

  it('max_rounds 子代理版说明截断事实与重新派遣方式，不含「发送继续」或设置指引', async () => {
    const result = await policy.shouldStopAfterTurn(makeArgs({
      ...successfulRound,
      toolRound: 20,
      maxToolRounds: 20
    }))

    expect(result).toMatchObject({ stop: true, reason: 'max_rounds' })
    expect(result?.notice).toContain('重新派遣')
    expect(result?.notice).not.toContain('发送「继续」')
    expect(result?.notice).not.toContain('设置')
  })

  it('breaker 子代理版不含「调整指令」类人类指引', async () => {
    const round = {
      toolCallsThisRound: [{ name: 'read', args: { path: 'missing.ts' } }],
      outcomes: [{
        toolCall: { id: 'tc', name: 'read' },
        args: { path: 'missing.ts' },
        resultText: 'not found',
        failed: true
      }]
    }
    await policy.shouldStopAfterTurn(makeArgs(round))
    await policy.shouldStopAfterTurn(makeArgs(round))
    await policy.shouldStopAfterTurn(makeArgs(round))

    const stopped = await policy.shouldStopAfterTurn(makeArgs(round))
    expect(stopped).toMatchObject({ stop: true, reason: 'breaker' })
    expect(stopped?.notice).not.toContain('请')
    expect(stopped?.notice).not.toContain('设置')
  })

  it('empty_args 子代理版不含 XML 兼容模式的设置指引', async () => {
    const emptyFailedRound = {
      toolCallsThisRound: [{ name: 'grep', args: {} }],
      outcomes: [{
        toolCall: { id: 'tc1', name: 'grep' },
        args: {},
        resultText: '错误',
        failed: true
      }]
    }
    await policy.shouldStopAfterTurn(makeArgs({ ...emptyFailedRound, toolRound: 1 }))
    await policy.shouldStopAfterTurn(makeArgs({ ...emptyFailedRound, toolRound: 2 }))

    const stopped = await policy.shouldStopAfterTurn(makeArgs({ ...emptyFailedRound, toolRound: 3 }))
    expect(stopped).toMatchObject({ stop: true, reason: 'empty_args' })
    expect(stopped?.notice).not.toContain('XML')
    expect(stopped?.notice).not.toContain('设置')
  })
})
