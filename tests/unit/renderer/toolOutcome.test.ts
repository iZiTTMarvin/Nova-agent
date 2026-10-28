/**
 * 工具终态展示语义：取消与失败不能混为一谈
 */
import { describe, expect, it } from 'vitest'
import {
  countToolOutcomes,
  formatToolOutcomeCounts,
  getToolOutcomeLabel,
  resolveToolOutcome
} from '../../../src/renderer/features/chat/toolOutcome'
import { USER_CANCELLED_TOOL_RESULT } from '../../../src/shared/session/toolCancellation'

describe('resolveToolOutcome', () => {
  it('running / success 直接对应', () => {
    expect(resolveToolOutcome({ status: 'running' })).toBe('running')
    expect(resolveToolOutcome({ status: 'success', result: 'ok' })).toBe('success')
  })

  it('error 带取消文本时是未完成，不是失败', () => {
    expect(resolveToolOutcome({ status: 'error', result: USER_CANCELLED_TOOL_RESULT })).toBe('incomplete')
    expect(resolveToolOutcome({ status: 'error', result: '搜索已取消：请求已取消' })).toBe('incomplete')
  })

  it('其余 error 才是可确认的失败，包括没有结果文本的 error', () => {
    expect(resolveToolOutcome({ status: 'error', result: 'HTTP 404' })).toBe('failed')
    expect(resolveToolOutcome({ status: 'error' })).toBe('failed')
  })
})

describe('getToolOutcomeLabel', () => {
  it('网页读取与搜索覆盖进行中、成功、失败、未完成', () => {
    expect(getToolOutcomeLabel('web_fetch', 'running')).toBe('正在读取')
    expect(getToolOutcomeLabel('web_fetch', 'success')).toBe('已读取')
    expect(getToolOutcomeLabel('web_fetch', 'failed')).toBe('读取失败')
    expect(getToolOutcomeLabel('web_search', 'running')).toBe('正在搜索')
    expect(getToolOutcomeLabel('web_search', 'success')).toBe('已搜索')
    expect(getToolOutcomeLabel('web_search', 'incomplete')).toBe('未完成')
  })

  it('其他工具成功时不额外加标签', () => {
    expect(getToolOutcomeLabel('read', 'success')).toBeNull()
    expect(getToolOutcomeLabel('bash', 'failed')).toBe('执行失败')
  })
})

describe('组头状态统计', () => {
  it('只列出真实存在的状态', () => {
    const counts = countToolOutcomes([
      { status: 'success', result: 'a' },
      { status: 'running' },
      { status: 'error', result: 'boom' },
      { status: 'error', result: USER_CANCELLED_TOOL_RESULT }
    ])
    expect(counts).toEqual({ running: 1, failed: 1, incomplete: 1 })
    expect(formatToolOutcomeCounts(counts)).toEqual(['1 项进行中', '1 项失败', '1 项未完成'])
    expect(formatToolOutcomeCounts(countToolOutcomes([{ status: 'success' }]))).toEqual([])
  })
})
