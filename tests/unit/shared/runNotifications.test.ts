/**
 * 系统通知纯函数：策略门禁与 run 快照差异检测。
 * 保护的用户行为：等待批准/终态时通知到人；用户看着窗口或关掉开关时不打扰。
 */
import { describe, it, expect } from 'vitest'
import {
  shouldShowNotification,
  detectRunNotificationTrigger,
  describeRunNotification
} from '../../../src/shared/notifications/runNotificationCopy'
import type { RunSnapshot, PendingInteraction } from '../../../src/shared/run/types'

function snapshot(overrides: Partial<RunSnapshot>): RunSnapshot {
  return {
    runId: 'run-1',
    kind: 'agent',
    workspaceId: 'ws',
    sessionId: 'session-1',
    messageId: 'msg-1',
    status: 'running',
    sequence: 1,
    pendingInteractions: [],
    currentAttempt: null,
    progress: null,
    lastHeartbeatAt: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  }
}

function pending(id: string, type: PendingInteraction['type']): PendingInteraction {
  return {
    interactionId: id,
    runId: 'run-1',
    sessionId: 'session-1',
    messageId: 'msg-1',
    type,
    status: 'pending',
    createdAt: 0,
    payload: {}
  }
}

describe('shouldShowNotification', () => {
  const base = { enabled: true, supported: true, windowFocused: false, onlyWhenUnfocused: true, e2e: false }

  it('开关关闭、平台不支持、E2E 环境一律不通知', () => {
    expect(shouldShowNotification({ ...base, enabled: false })).toBe(false)
    expect(shouldShowNotification({ ...base, supported: false })).toBe(false)
    expect(shouldShowNotification({ ...base, e2e: true })).toBe(false)
  })

  it('仅失焦模式下聚焦不通知，失焦通知；关闭仅失焦模式后聚焦也通知', () => {
    expect(shouldShowNotification({ ...base, windowFocused: true })).toBe(false)
    expect(shouldShowNotification({ ...base, windowFocused: false })).toBe(true)
    expect(shouldShowNotification({ ...base, onlyWhenUnfocused: false, windowFocused: true })).toBe(true)
  })
})

describe('detectRunNotificationTrigger', () => {
  it('新出现的 pending 交互触发通知，且优先于终态', () => {
    const prev = snapshot({})
    const next = snapshot({ status: 'waiting_user', pendingInteractions: [pending('i1', 'permission')] })
    expect(detectRunNotificationTrigger(prev, next)).toEqual({
      kind: 'pendingInteraction',
      interactionId: 'i1'
    })
  })

  it('已存在的 pending 不重复通知', () => {
    const prev = snapshot({ pendingInteractions: [pending('i1', 'permission')] })
    const next = snapshot({ status: 'waiting_user', pendingInteractions: [pending('i1', 'permission')], sequence: 2 })
    expect(detectRunNotificationTrigger(prev, next)).toBeNull()
  })

  it('running → completed 触发终态通知；终态之间不重复触发', () => {
    const prev = snapshot({ status: 'running' })
    const next = snapshot({ status: 'completed', sequence: 2 })
    expect(detectRunNotificationTrigger(prev, next)).toEqual({ kind: 'terminal', status: 'completed' })
    const again = snapshot({ status: 'completed', sequence: 3 })
    expect(detectRunNotificationTrigger(next, again)).toBeNull()
  })

  it('running → failed 触发终态通知；用户主动取消不通知', () => {
    const prev = snapshot({ status: 'running' })
    expect(detectRunNotificationTrigger(prev, snapshot({ status: 'failed', sequence: 2 })))
      .toEqual({ kind: 'terminal', status: 'failed' })
    expect(detectRunNotificationTrigger(prev, snapshot({ status: 'cancelled', sequence: 2 }))).toBeNull()
  })

  it('answered 的交互不算新 pending', () => {
    const prev = snapshot({})
    const answered = { ...pending('i1', 'askQuestion'), status: 'answered' as const }
    expect(detectRunNotificationTrigger(prev, snapshot({ pendingInteractions: [answered] }))).toBeNull()
  })
})

describe('describeRunNotification', () => {
  it('终态与待批准文案说人话，会话标题优先于 id', () => {
    const snap = snapshot({ terminalReason: '模型调用失败' })
    expect(describeRunNotification({ kind: 'terminal', status: 'completed' }, snap, '修 bug'))
      .toEqual({ title: '任务完成', body: '修 bug' })
    expect(describeRunNotification({ kind: 'terminal', status: 'failed' }, snap, '修 bug').title)
      .toBe('任务失败')
    const waiting = snapshot({ pendingInteractions: [pending('i1', 'planApproval')] })
    expect(describeRunNotification({ kind: 'pendingInteraction', interactionId: 'i1' }, waiting).title)
      .toBe('需要你的确认')
  })

  it('无标题时回退到会话 id 短码', () => {
    const copy = describeRunNotification(
      { kind: 'terminal', status: 'completed' },
      snapshot({ sessionId: 'session-abcdef123' })
    )
    expect(copy.body).toContain('#def123')
  })
})
