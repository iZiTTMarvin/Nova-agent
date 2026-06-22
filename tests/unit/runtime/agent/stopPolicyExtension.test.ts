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
})
