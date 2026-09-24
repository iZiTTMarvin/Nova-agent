import { describe, expect, it } from 'vitest'
import { parseLearningAction, parseLearningCommand } from '../../../../src/shared/learning/command'

describe('learning command parsing', () => {
  it('解析 answer 并限制 optionIds', () => {
    const cmd = parseLearningCommand({
      commandId: 'cmd-1',
      sessionId: 'sess-1',
      expectedClearGeneration: 2,
      expectedCursorVersion: 3,
      action: {
        type: 'answer',
        checkpointId: 'ckpt',
        text: '我的理解',
        optionIds: ['a']
      }
    })
    expect(cmd.action.type).toBe('answer')
  })

  it('未知 action 拒绝', () => {
    expect(() =>
      parseLearningCommand({
        commandId: 'cmd-1',
        sessionId: 'sess-1',
        expectedClearGeneration: 0,
        expectedCursorVersion: 0,
        action: { type: 'nope' }
      })
    ).toThrow()
  })
})
