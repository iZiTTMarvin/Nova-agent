/**
 * turnProcessSelectors 单测
 */
import { describe, expect, it } from 'vitest'
import { selectForceExpandedForMessage } from '../../../src/renderer/features/chat/turnProcessSelectors'
import type { AgentState } from '../../../src/renderer/stores/useAgentStore'

function baseState(overrides: Partial<AgentState> = {}): AgentState {
  return {
    pendingPermissionRequest: null,
    isSubmittingPermission: false,
    permissionError: null,
    pendingVerificationRequest: null,
    pendingAskQuestion: null,
    cancelExecution: async () => {},
    clearCancelFallback: () => {},
    handlePermissionRequest: () => {},
    respondPermissionRequest: async () => {},
    handleVerificationPermissionRequest: () => {},
    clearVerificationPermissionRequest: () => {},
    respondVerificationPermission: () => {},
    handleAskQuestionRequest: () => {},
    clearAskQuestionRequest: () => {},
    respondAskQuestion: async () => {},
    dismissAskQuestion: async () => {},
    resetAgentRuntime: () => {},
    ...overrides
  }
}

describe('selectForceExpandedForMessage', () => {
  it('非 live 恒 false', () => {
    const state = baseState({
      pendingPermissionRequest: {
        messageId: 'msg_1',
        requestId: 'r1',
        toolName: 'bash',
        args: {},
        riskLevel: 'medium',
        reason: 'test'
      }
    })
    expect(selectForceExpandedForMessage(state, 'msg_1', false)).toBe(false)
  })

  it('权限请求仅命中对应 messageId', () => {
    const state = baseState({
      pendingPermissionRequest: {
        messageId: 'msg_1',
        requestId: 'r1',
        toolName: 'bash',
        args: {},
        riskLevel: 'medium',
        reason: 'test'
      }
    })
    expect(selectForceExpandedForMessage(state, 'msg_1', true)).toBe(true)
    expect(selectForceExpandedForMessage(state, 'msg_2', true)).toBe(false)
  })

  it('askQuestion 挂起时 live 消息强制展开', () => {
    const state = baseState({
      pendingAskQuestion: { requestId: 'aq1', questions: [] }
    })
    expect(selectForceExpandedForMessage(state, 'msg_live', true)).toBe(true)
    expect(selectForceExpandedForMessage(state, 'msg_old', false)).toBe(false)
  })

  it('验证权限挂起时 live 消息强制展开', () => {
    const state = baseState({
      pendingVerificationRequest: { requestId: 'v1', command: 'npm test' }
    })
    expect(selectForceExpandedForMessage(state, 'msg_live', true)).toBe(true)
  })
})
