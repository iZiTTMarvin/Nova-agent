import { describe, expect, it } from 'vitest'
import {
  isPlanReviewPermissionPayload,
  parsePlanReviewCommand
} from '../../../src/shared/planReview'

describe('parsePlanReviewCommand', () => {
  it('归一化合法 revise 命令的反馈', () => {
    expect(parsePlanReviewCommand({
      interactionId: 'interaction-1',
      commandId: 'command-1',
      expectedVersion: 2,
      decision: 'revise',
      feedback: '  补充回滚方案  '
    })).toEqual({
      ok: true,
      command: {
        interactionId: 'interaction-1',
        commandId: 'command-1',
        expectedVersion: 2,
        decision: 'revise',
        feedback: '补充回滚方案'
      }
    })
  })

  it.each([
    null,
    [],
    { interactionId: '', commandId: 'c', expectedVersion: 1, decision: 'approve' },
    { interactionId: 'i', commandId: 'c', expectedVersion: 0, decision: 'approve' },
    { interactionId: 'i', commandId: 'c', expectedVersion: 1, decision: 'revise' },
    { interactionId: 'i', commandId: 'c', expectedVersion: 1, decision: 'ignore', feedback: '多余' },
    { interactionId: 'i', commandId: 'c', expectedVersion: 1, decision: 'approve', extra: true }
  ])('严格拒绝非法或包含未知字段的命令 %#', (input) => {
    expect(parsePlanReviewCommand(input).ok).toBe(false)
  })
})

describe('isPlanReviewPermissionPayload', () => {
  it('只识别 switch_mode(default)，避免旧权限条重复消费计划审批', () => {
    expect(isPlanReviewPermissionPayload({
      toolName: 'switch_mode',
      args: { mode: 'default' }
    })).toBe(true)
    expect(isPlanReviewPermissionPayload({
      toolName: 'switch_mode',
      args: { mode: 'plan' }
    })).toBe(false)
    expect(isPlanReviewPermissionPayload({
      toolName: 'bash',
      args: { command: 'git status' }
    })).toBe(false)
  })
})
