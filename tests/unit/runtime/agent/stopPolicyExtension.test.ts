import { describe, expect, it, beforeEach } from 'vitest'
import {
  StopPolicyExtension,
  EMPTY_ARGS_LIMIT
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

  it(`连续 ${EMPTY_ARGS_LIMIT} 轮全空参 → 返回 empty_args 停止`, async () => {
    const round = {
      toolCallsThisRound: [{ name: 'grep', args: {} }],
      outcomes: [{
        toolCall: { id: 'tc1', name: 'grep' },
        args: {},
        resultText: '错误',
        failed: true
      }]
    }

    const first = await policy.shouldStopAfterTurn(makeArgs({ ...round, toolRound: 1 }))
    expect(first).toBeUndefined()

    const second = await policy.shouldStopAfterTurn(makeArgs({ ...round, toolRound: 2 }))
    expect(second?.stop).toBe(true)
    expect(second?.reason).toBe('empty_args')
    expect(second?.notice).toContain('XML 兼容模式')
  })

  it('中间出现非空参 → 计数清零，不触发', async () => {
    const emptyRound = {
      toolCallsThisRound: [{ name: 'grep', args: {} }],
      outcomes: [{
        toolCall: { id: 'tc1', name: 'grep' },
        args: {},
        resultText: '错误',
        failed: true
      }]
    }

    await policy.shouldStopAfterTurn(makeArgs({ ...emptyRound, toolRound: 1 }))

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

    const third = await policy.shouldStopAfterTurn(makeArgs({ ...emptyRound, toolRound: 3 }))
    expect(third).toBeUndefined()
  })

  it('中间出现成功执行 → 计数清零', async () => {
    const emptyRound = {
      toolCallsThisRound: [{ name: 'grep', args: {} }],
      outcomes: [{
        toolCall: { id: 'tc1', name: 'grep' },
        args: {},
        resultText: '错误',
        failed: true
      }]
    }

    await policy.shouldStopAfterTurn(makeArgs({ ...emptyRound, toolRound: 1 }))

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

    const third = await policy.shouldStopAfterTurn(makeArgs({ ...emptyRound, toolRound: 3 }))
    expect(third).toBeUndefined()
  })

  it('clear() 重置空参计数', async () => {
    const round = {
      toolCallsThisRound: [{ name: 'read', args: {} }],
      outcomes: [{
        toolCall: { id: 'tc1', name: 'read' },
        args: {},
        resultText: '错误',
        failed: true
      }]
    }

    await policy.shouldStopAfterTurn(makeArgs({ ...round, toolRound: 1 }))
    policy.clear()

    const again = await policy.shouldStopAfterTurn(makeArgs({ ...round, toolRound: 1 }))
    expect(again).toBeUndefined()
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
