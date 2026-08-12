/**
 * 交互契约：permission/askQuestion 身份错配拒绝。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const coordinator = vi.hoisted(() => ({
  findInteraction: vi.fn(),
  getSnapshot: vi.fn(),
  inbox: {
    answer: vi.fn(),
    cancelAllForRun: vi.fn()
  },
  beginCancel: vi.fn(),
  commitTerminal: vi.fn()
}))

const executionRegistry = vi.hoisted(() => ({
  get: vi.fn(),
  isCurrent: vi.fn()
}))

const loopLookup = vi.hoisted(() => ({
  // 并发改造后不再有全局 loop 兜底；保留字段仅避免老用例引用报错，不再被模块使用
  current: vi.fn(),
  byRun: vi.fn()
}))

vi.mock('../../../src/main/services/RunCoordinatorHost', () => ({
  getRunCoordinator: () => coordinator,
  getRunExecutionRegistry: () => executionRegistry,
  getActiveRunId: () => null
}))

vi.mock('../../../src/main/services/SubagentLifecycleHost', () => ({
  getSubagentLifecycleCoordinator: () => ({ cancelRunTree: vi.fn() })
}))

vi.mock('../../../src/main/agent/events', () => ({
  markActiveStreamsCancelled: vi.fn()
}))

vi.mock('../../../src/main/agent/turn', () => ({
  getAgentLoopForRun: loopLookup.byRun
}))

import {
  respondAskQuestion,
  respondPermission
} from '../../../src/main/agent/interaction/AgentInteractionController'
import { pendingAskQuestions } from '../../../src/main/agent/interaction/askQuestionWaiters'

describe('AgentInteractionController 契约', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    coordinator.findInteraction.mockReturnValue(null)
    coordinator.getSnapshot.mockReturnValue(null)
    executionRegistry.get.mockReturnValue(null)
    executionRegistry.isCurrent.mockReturnValue(false)
    loopLookup.current.mockReturnValue(null)
    loopLookup.byRun.mockReturnValue(undefined)
    pendingAskQuestions.clear()
  })

  it('permission requestId 与 durable payload 错配时拒绝，不唤醒 AgentLoop', async () => {
    coordinator.findInteraction.mockReturnValue({
      interactionId: 'int_1',
      runId: 'run_1',
      sessionId: 's1',
      messageId: 'm1',
      type: 'permission',
      status: 'pending',
      version: 1,
      createdAt: 1,
      payload: { requestId: 'real_req' }
    })
    coordinator.getSnapshot.mockReturnValue({ runId: 'run_1', status: 'waiting_user' })

    const result = await respondPermission({
      requestId: 'spoofed_req',
      decision: 'allow',
      commandId: 'cmd_1',
      interactionId: 'int_1',
      expectedVersion: 1
    })

    expect(result).toMatchObject({ ok: false, code: 'identity_mismatch' })
    expect(coordinator.inbox.answer).not.toHaveBeenCalled()
  })

  it('askQuestion requestId 与 durable payload 错配时拒绝', async () => {
    coordinator.findInteraction.mockReturnValue({
      interactionId: 'aq_1',
      runId: 'run_1',
      sessionId: 's1',
      messageId: 'm1',
      type: 'askQuestion',
      status: 'pending',
      version: 1,
      createdAt: 1,
      payload: { requestId: 'real_aq' }
    })
    coordinator.getSnapshot.mockReturnValue({ runId: 'run_1', status: 'waiting_user' })

    const result = await respondAskQuestion({
      requestId: 'spoofed_aq',
      answers: [{ questionId: 'q1', selectedOptionIds: ['a'] }],
      commandId: 'cmd_aq',
      interactionId: 'aq_1',
      expectedVersion: 1
    })

    expect(result).toMatchObject({ ok: false, code: 'identity_mismatch' })
    expect(coordinator.inbox.answer).not.toHaveBeenCalled()
  })

  it('permission 不得回答 askQuestion interaction', async () => {
    coordinator.findInteraction.mockReturnValue({
      interactionId: 'aq_1',
      runId: 'run_1',
      sessionId: 's1',
      messageId: 'm1',
      type: 'askQuestion',
      status: 'pending',
      version: 1,
      createdAt: 1,
      payload: { requestId: 'aq_1' }
    })

    const result = await respondPermission({
      requestId: 'aq_1',
      decision: 'allow',
      commandId: 'cmd_wrong_type',
      interactionId: 'aq_1',
      expectedVersion: 1
    })

    expect(result).toMatchObject({ ok: false, code: 'identity_mismatch' })
    expect(coordinator.inbox.answer).not.toHaveBeenCalled()
  })

  it('askQuestion waiter 的 run 错配时不得先修改 durable interaction', async () => {
    const found = {
      interactionId: 'aq_1',
      runId: 'run_1',
      sessionId: 's1',
      messageId: 'm1',
      type: 'askQuestion' as const,
      status: 'pending' as const,
      version: 1,
      createdAt: 1,
      payload: { requestId: 'aq_1' }
    }
    coordinator.findInteraction.mockReturnValue(found)
    coordinator.getSnapshot.mockReturnValue({
      runId: 'run_1', sessionId: 's1', status: 'waiting_user', executionGeneration: 7
    })
    executionRegistry.get.mockReturnValue({ runId: 'run_1', generation: 7 })
    executionRegistry.isCurrent.mockReturnValue(true)
    const resolve = vi.fn()
    pendingAskQuestions.set('aq_1', {
      runId: 'run_2',
      resolve,
      eventBus: { emit: vi.fn() } as never
    })

    const result = await respondAskQuestion({
      requestId: 'aq_1',
      answers: [{ selectedLabels: ['A'] }],
      commandId: 'cmd_aq',
      interactionId: 'aq_1',
      expectedVersion: 1
    })

    expect(result).toMatchObject({ ok: false, code: 'identity_mismatch' })
    expect(coordinator.inbox.answer).not.toHaveBeenCalled()
    expect(resolve).not.toHaveBeenCalled()
  })

  it('durable permission 找不到所属 run 的 AgentLoop 时不得回退当前 loop', async () => {
    const found = {
      interactionId: 'perm_1',
      runId: 'run_1',
      sessionId: 's1',
      messageId: 'm1',
      type: 'permission' as const,
      status: 'pending' as const,
      version: 1,
      createdAt: 1,
      payload: { requestId: 'perm_1' }
    }
    coordinator.findInteraction.mockReturnValue(found)
    coordinator.getSnapshot.mockReturnValue({
      runId: 'run_1', sessionId: 's1', status: 'waiting_user', executionGeneration: 7
    })
    executionRegistry.get.mockReturnValue({ runId: 'run_1', generation: 7 })
    executionRegistry.isCurrent.mockReturnValue(true)
    const currentLoop = { respondPermission: vi.fn() }
    loopLookup.current.mockReturnValue(currentLoop)
    loopLookup.byRun.mockReturnValue(undefined)

    const result = await respondPermission({
      requestId: 'perm_1',
      decision: 'allow',
      commandId: 'cmd_perm',
      interactionId: 'perm_1',
      expectedVersion: 1
    })

    expect(result).toMatchObject({ ok: false, code: 'identity_mismatch' })
    expect(coordinator.inbox.answer).not.toHaveBeenCalled()
    expect(currentLoop.respondPermission).not.toHaveBeenCalled()
  })

  it('permission 只唤醒 durable interaction 所属 run 的当前 generation loop', async () => {
    const found = {
      interactionId: 'perm_1',
      runId: 'run_1',
      sessionId: 's1',
      messageId: 'm1',
      type: 'permission' as const,
      status: 'pending' as const,
      version: 1,
      createdAt: 1,
      payload: { requestId: 'perm_1' }
    }
    const snapshot = {
      runId: 'run_1', sessionId: 's1', status: 'waiting_user', executionGeneration: 7
    }
    coordinator.findInteraction.mockReturnValue(found)
    coordinator.getSnapshot.mockReturnValue(snapshot)
    coordinator.inbox.answer.mockReturnValue({
      ok: true, firstApplied: true, interaction: found, snapshot
    })
    executionRegistry.get.mockReturnValue({ runId: 'run_1', generation: 7 })
    executionRegistry.isCurrent.mockReturnValue(true)
    const runLoop = { respondPermission: vi.fn(), hasPendingPermission: vi.fn(() => true) }
    const currentLoop = { respondPermission: vi.fn() }
    loopLookup.byRun.mockReturnValue(runLoop)
    loopLookup.current.mockReturnValue(currentLoop)

    const result = await respondPermission({
      requestId: 'perm_1',
      decision: 'allow',
      commandId: 'cmd_perm',
      interactionId: 'perm_1',
      expectedVersion: 1
    })

    expect(result).toMatchObject({ ok: true, firstApplied: true })
    expect(runLoop.respondPermission).toHaveBeenCalledWith('perm_1', true)
    expect(currentLoop.respondPermission).not.toHaveBeenCalled()
  })

  it('permission generation 失效时不得修改 durable interaction 或唤醒 loop', async () => {
    const found = {
      interactionId: 'perm_1',
      runId: 'run_1',
      sessionId: 's1',
      messageId: 'm1',
      type: 'permission' as const,
      status: 'pending' as const,
      version: 1,
      createdAt: 1,
      payload: { requestId: 'perm_1' }
    }
    coordinator.findInteraction.mockReturnValue(found)
    coordinator.getSnapshot.mockReturnValue({
      runId: 'run_1', sessionId: 's1', status: 'waiting_user', executionGeneration: 8
    })
    executionRegistry.get.mockReturnValue({ runId: 'run_1', generation: 7 })
    executionRegistry.isCurrent.mockReturnValue(true)
    const runLoop = { respondPermission: vi.fn(), hasPendingPermission: vi.fn(() => true) }
    loopLookup.byRun.mockReturnValue(runLoop)

    const result = await respondPermission({
      requestId: 'perm_1',
      decision: 'allow',
      commandId: 'cmd_stale',
      interactionId: 'perm_1',
      expectedVersion: 1
    })

    expect(result).toMatchObject({ ok: false, code: 'identity_mismatch' })
    expect(coordinator.inbox.answer).not.toHaveBeenCalled()
    expect(runLoop.respondPermission).not.toHaveBeenCalled()
  })

  it('run loop 不持有 permission resolver 时不得先修改 durable interaction', async () => {
    const found = {
      interactionId: 'perm_1',
      runId: 'run_1',
      sessionId: 's1',
      messageId: 'm1',
      type: 'permission' as const,
      status: 'pending' as const,
      version: 1,
      createdAt: 1,
      payload: { requestId: 'perm_1' }
    }
    coordinator.findInteraction.mockReturnValue(found)
    coordinator.getSnapshot.mockReturnValue({
      runId: 'run_1', sessionId: 's1', status: 'waiting_user', executionGeneration: 7
    })
    executionRegistry.get.mockReturnValue({ runId: 'run_1', generation: 7 })
    executionRegistry.isCurrent.mockReturnValue(true)
    const runLoop = { respondPermission: vi.fn(), hasPendingPermission: vi.fn(() => false) }
    loopLookup.byRun.mockReturnValue(runLoop)

    const result = await respondPermission({
      requestId: 'perm_1',
      decision: 'allow',
      commandId: 'cmd_orphan',
      interactionId: 'perm_1',
      expectedVersion: 1
    })

    expect(result).toMatchObject({ ok: false, code: 'identity_mismatch' })
    expect(coordinator.inbox.answer).not.toHaveBeenCalled()
    expect(runLoop.respondPermission).not.toHaveBeenCalled()
  })

  it('Child Session permission 以 child run 原始 requestId 路由到自己的 AgentLoop', async () => {
    const found = {
      interactionId: 'child-permission',
      runId: 'run-child',
      sessionId: 'session-child',
      messageId: 'msg-child',
      type: 'permission' as const,
      status: 'pending' as const,
      version: 1,
      createdAt: 1,
      payload: { requestId: 'child-permission' }
    }
    const snapshot = {
      runId: 'run-child',
      sessionId: 'session-child',
      status: 'waiting_user',
      executionGeneration: 8
    }
    const durable = { ok: true, firstApplied: true, interaction: found, snapshot }
    coordinator.findInteraction.mockReturnValue(found)
    coordinator.getSnapshot.mockReturnValue(snapshot)
    coordinator.inbox.answer.mockReturnValue(durable)
    executionRegistry.get.mockReturnValue({ runId: 'run-child', generation: 8 })
    executionRegistry.isCurrent.mockReturnValue(true)
    const childLoop = {
      hasPendingPermission: vi.fn(() => true),
      respondPermission: vi.fn()
    }
    loopLookup.byRun.mockReturnValue(childLoop)

    const result = await respondPermission({
      requestId: 'child-permission',
      decision: 'allow',
      commandId: 'answer-child',
      interactionId: 'child-permission',
      expectedVersion: 1
    })

    expect(result).toEqual(durable)
    expect(childLoop.respondPermission).toHaveBeenCalledWith('child-permission', true)
  })

  it('重启后的 interrupted child 可先 durable 回答 pending permission，再等待显式 resume', async () => {
    const found = {
      interactionId: 'child-pending',
      runId: 'run-child',
      sessionId: 'session-child',
      messageId: 'msg-child',
      type: 'permission' as const,
      status: 'pending' as const,
      version: 1,
      createdAt: 1,
      payload: { requestId: 'child-pending' }
    }
    const snapshot = {
      runId: 'run-child',
      sessionId: 'session-child',
      status: 'interrupted',
      executionGeneration: 0
    }
    const durable = { ok: true, firstApplied: true, interaction: found, snapshot }
    coordinator.findInteraction.mockReturnValue(found)
    coordinator.getSnapshot.mockReturnValue(snapshot)
    coordinator.inbox.answer.mockReturnValue(durable)

    const result = await respondPermission({
      requestId: 'child-pending',
      decision: 'deny',
      commandId: 'answer-after-restart',
      interactionId: 'child-pending',
      expectedVersion: 1
    })

    expect(result).toEqual(durable)
    expect(coordinator.inbox.answer).toHaveBeenCalled()
    expect(executionRegistry.get).not.toHaveBeenCalled()
    expect(loopLookup.byRun).toHaveBeenCalledWith('run-child')
  })

  it('重复 permission command 返回 durable ACK，不要求已结束 generation 仍存活', async () => {
    const found = {
      interactionId: 'perm_1',
      runId: 'run_1',
      sessionId: 's1',
      messageId: 'm1',
      type: 'permission' as const,
      status: 'answered' as const,
      version: 2,
      createdAt: 1,
      payload: { requestId: 'perm_1' }
    }
    const snapshot = { runId: 'run_1', sessionId: 's1', status: 'completed' }
    const duplicate = {
      ok: true, firstApplied: false, duplicate: true, interaction: found, snapshot
    }
    coordinator.findInteraction.mockReturnValue(found)
    coordinator.getSnapshot.mockReturnValue(snapshot)
    coordinator.inbox.answer.mockReturnValue(duplicate)
    const currentLoop = { respondPermission: vi.fn() }
    loopLookup.current.mockReturnValue(currentLoop)

    const result = await respondPermission({
      requestId: 'perm_1',
      decision: 'allow',
      commandId: 'cmd_duplicate',
      interactionId: 'perm_1',
      expectedVersion: 1
    })

    expect(result).toEqual(duplicate)
    expect(executionRegistry.get).not.toHaveBeenCalled()
    expect(currentLoop.respondPermission).not.toHaveBeenCalled()
  })

  it('askQuestion 完整校验后才提交 durable answer 并 resolve 对应 waiter', async () => {
    const found = {
      interactionId: 'aq_1',
      runId: 'run_1',
      sessionId: 's1',
      messageId: 'm1',
      type: 'askQuestion' as const,
      status: 'pending' as const,
      version: 1,
      createdAt: 1,
      payload: { requestId: 'aq_1' }
    }
    const snapshot = {
      runId: 'run_1', sessionId: 's1', status: 'running', executionGeneration: 7
    }
    const durable = { ok: true, firstApplied: true, interaction: found, snapshot }
    coordinator.findInteraction.mockReturnValue(found)
    coordinator.getSnapshot.mockReturnValue(snapshot)
    coordinator.inbox.answer.mockReturnValue(durable)
    executionRegistry.get.mockReturnValue({ runId: 'run_1', generation: 7 })
    executionRegistry.isCurrent.mockReturnValue(true)
    const resolve = vi.fn()
    const emit = vi.fn()
    pendingAskQuestions.set('aq_1', {
      runId: 'run_1',
      resolve,
      eventBus: { emit } as never
    })
    const answers = [{ selectedLabels: ['A'] }]

    const result = await respondAskQuestion({
      requestId: 'aq_1',
      answers,
      commandId: 'cmd_aq',
      interactionId: 'aq_1',
      expectedVersion: 1
    })

    expect(result).toEqual(durable)
    expect(coordinator.inbox.answer).toHaveBeenCalledOnce()
    expect(resolve).toHaveBeenCalledWith(answers)
    expect(emit).toHaveBeenCalledWith({ type: 'ask_question_resolved', requestId: 'aq_1' })
    expect(pendingAskQuestions.has('aq_1')).toBe(false)
  })
})
