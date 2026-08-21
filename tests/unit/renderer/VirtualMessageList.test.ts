import { describe, expect, it } from 'vitest'
import { findLatestPlanMessageId } from '../../../src/renderer/features/chat/VirtualMessageList'
import type { ExtendedMessage } from '../../../src/renderer/stores/types'

function savePlanMessage(id: string, status: 'running' | 'success' | 'error'): ExtendedMessage {
  return {
    id,
    sessionId: 'sess_1',
    role: 'assistant',
    content: '',
    timestamp: 1,
    _revision: 0,
    blocks: [
      {
        type: 'tool',
        toolCallId: `call_${id}`,
        toolName: 'save_plan',
        status,
        arguments: { title: '计划' }
      }
    ]
  }
}

function plainMessage(id: string, role: ExtendedMessage['role'] = 'user'): ExtendedMessage {
  return {
    id,
    sessionId: 'sess_1',
    role,
    content: '普通消息',
    timestamp: 1,
    _revision: 0
  }
}

describe('findLatestPlanMessageId', () => {
  it('没有成功保存的计划时返回 null', () => {
    expect(findLatestPlanMessageId([
      plainMessage('m_user'),
      savePlanMessage('m_running', 'running'),
      savePlanMessage('m_error', 'error')
    ])).toBeNull()
  })

  it('取消息流中最后一张成功保存计划的消息', () => {
    expect(findLatestPlanMessageId([
      savePlanMessage('m_first', 'success'),
      plainMessage('m_user'),
      savePlanMessage('m_second', 'success')
    ])).toBe('m_second')
  })

  it('最新轮计划仍 running/error 时回溯到更早的成功计划', () => {
    expect(findLatestPlanMessageId([
      savePlanMessage('m_older', 'success'),
      savePlanMessage('m_running', 'running')
    ])).toBe('m_older')
    expect(findLatestPlanMessageId([
      savePlanMessage('m_older', 'success'),
      savePlanMessage('m_error', 'error')
    ])).toBe('m_older')
  })

  it('跳过用户消息与不含 save_plan 的 assistant 消息', () => {
    expect(findLatestPlanMessageId([
      plainMessage('m_user'),
      plainMessage('m_assistant', 'assistant'),
      savePlanMessage('m_success', 'success')
    ])).toBe('m_success')
  })
})
