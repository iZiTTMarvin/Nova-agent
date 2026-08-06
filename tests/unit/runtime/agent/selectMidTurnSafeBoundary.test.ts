import { describe, expect, it } from 'vitest'
import { selectMidTurnSafeBoundary } from '../../../../src/runtime/agent/compaction/selectMidTurnSafeBoundary'
import type { ChatMessage } from '../../../../src/runtime/model/types'

function toolPair(callId: string, name = 'read'): ChatMessage[] {
  return [
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: callId, name, arguments: '{}' }]
    },
    { role: 'tool', content: `result-${callId}`, toolCallId: callId }
  ]
}

describe('selectMidTurnSafeBoundary', () => {
  it('永不切断工具 call/result 对', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'start' },
      ...toolPair('c1'),
      ...toolPair('c2'),
      { role: 'user', content: 'tail' }
    ]
    const boundary = selectMidTurnSafeBoundary(messages, { reserveTailMessages: 1 })
    expect(boundary).toEqual({ ok: true, coveredCount: 5 })
    // covered 侧不得留下孤儿 toolCalls
    const covered = messages.slice(0, 5)
    expect(covered.filter(m => m.role === 'assistant' && m.toolCalls).length).toBe(2)
    expect(covered.filter(m => m.role === 'tool').length).toBe(2)
  })

  it('partial 回退：切点严格落在首个 partial 之前', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
      { role: 'user', content: 'partial-body' },
      { role: 'assistant', content: 'c' }
    ]
    const boundary = selectMidTurnSafeBoundary(messages, {
      reserveTailMessages: 1,
      isPartial: (_message, index) => index === 2
    })
    expect(boundary).toEqual({ ok: true, coveredCount: 2 })
  })

  it('仅剩单个原子工具对时返回无可折叠前缀', () => {
    const messages: ChatMessage[] = toolPair('only')
    const boundary = selectMidTurnSafeBoundary(messages, { reserveTailMessages: 1 })
    expect(boundary).toEqual({ ok: false, reason: 'no_safe_completed_span' })
  })

  it('open tool call（结果尚未落地）不得被覆盖', () => {
    const messages: ChatMessage[] = [
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'open', name: 'read', arguments: '{}' }]
      }
    ]
    const boundary = selectMidTurnSafeBoundary(messages, { reserveTailMessages: 0 })
    expect(boundary).toEqual({ ok: false, reason: 'no_safe_completed_span' })
  })

  it('open tool call 之前的已完成前缀仍可折叠', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'a' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'open', name: 'read', arguments: '{}' }]
      }
    ]
    const boundary = selectMidTurnSafeBoundary(messages, { reserveTailMessages: 0 })
    expect(boundary).toEqual({ ok: true, coveredCount: 2 })
  })

  it('默认保留尾部至少 1 条原文', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: '1' },
      { role: 'assistant', content: '2' },
      { role: 'user', content: '3' }
    ]
    const boundary = selectMidTurnSafeBoundary(messages)
    expect(boundary).toEqual({ ok: true, coveredCount: 2 })
  })
})
