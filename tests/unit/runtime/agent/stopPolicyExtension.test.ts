import { describe, expect, it, beforeEach } from 'vitest'
import {
  StopPolicyExtension,
  EMPTY_ARGS_LIMIT,
  REPEATED_FAILURE_LIMIT
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
