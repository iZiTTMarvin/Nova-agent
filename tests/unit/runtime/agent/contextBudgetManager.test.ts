/**
 * T5-3 ContextBudgetManager
 */
import { describe, it, expect } from 'vitest'
import { extractTextFromContent } from '../../../../src/runtime/model/types'
import type { ChatMessage } from '../../../../src/runtime/model/types'
import {
  applyContextBudget,
  ContextBudgetManager,
  BUDGET_ARTIFACT_BYTES
} from '../../../../src/runtime/agent/ContextBudgetManager'
import { AGING_GROUP_BYTES_THRESHOLD } from '../../../../src/runtime/agent/compaction/toolResultAging'
import { MIN_RECENT_MESSAGES } from '../../../../src/runtime/agent/compaction/compaction'

function buildLongToolContext(rounds: number, toolBytes: number): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: 'system', content: 'sys' }]
  for (let i = 0; i < rounds; i++) {
    messages.push({ role: 'user', content: `u${i}` })
    messages.push({
      role: 'assistant',
      content: '',
      toolCalls: [{ id: `tc_${i}`, name: 'bash', arguments: '{}' }]
    })
    messages.push({
      role: 'tool',
      content: `line1\n${'x'.repeat(toolBytes)}`,
      toolCallId: `tc_${i}`,
      ...(toolBytes > BUDGET_ARTIFACT_BYTES ? { artifactId: `art_${i}` } : {})
    })
  }
  return messages
}

function assertPairing(messages: ChatMessage[]): void {
  const toolIds = new Set(
    messages.filter(m => m.role === 'tool' && m.toolCallId).map(m => m.toolCallId!)
  )
  for (const m of messages) {
    if (m.role === 'assistant' && m.toolCalls) {
      for (const tc of m.toolCalls) {
        expect(toolIds.has(tc.id)).toBe(true)
      }
    }
  }
}

describe('T5-3 ContextBudgetManager', () => {
  it('旧大工具组被 aging 为摘要，配对仍合法', () => {
    const ctx = buildLongToolContext(35, AGING_GROUP_BYTES_THRESHOLD + 100)
    const { messages, provenance } = applyContextBudget(ctx)
    assertPairing(messages)

    const aged = messages.filter(
      m => m.role === 'tool' && extractTextFromContent(m.content).startsWith('[aged tool result]')
    )
    expect(aged.length).toBeGreaterThan(0)
    expect(Object.values(provenance).some(p => p === 'aged_summary')).toBe(true)
  })

  it('大输出 + artifact → artifact_ref', () => {
    const ctx = buildLongToolContext(35, BUDGET_ARTIFACT_BYTES + 500)
    const { messages, provenance } = applyContextBudget(ctx)
    const refs = messages.filter(
      m => m.role === 'tool' && extractTextFromContent(m.content).startsWith('[artifact ref]')
    )
    expect(refs.length).toBeGreaterThan(0)
    expect(Object.values(provenance).some(p => p === 'artifact_ref')).toBe(true)
  })

  it(`最近 ${MIN_RECENT_MESSAGES} 条内工具结果保持全文`, () => {
    const ctx = buildLongToolContext(30, AGING_GROUP_BYTES_THRESHOLD + 100)
    const { messages } = applyContextBudget(ctx)
    const nonSystem = messages.filter(m => m.role !== 'system')
    const recent = nonSystem.slice(-MIN_RECENT_MESSAGES)
    const recentTools = recent.filter(m => m.role === 'tool')
    for (const t of recentTools) {
      const text = extractTextFromContent(t.content)
      expect(text.startsWith('[aged tool result]')).toBe(false)
      expect(text.startsWith('[superseded')).toBe(false)
    }
  })

  it('同路径 read 旧结果可被 superseded', () => {
    const messages: ChatMessage[] = [{ role: 'system', content: 'sys' }]
    for (let i = 0; i < 25; i++) {
      messages.push({ role: 'user', content: `u${i}` })
      messages.push({
        role: 'assistant',
        content: '',
        toolCalls: [{ id: `tc_${i}`, name: 'read', arguments: '{"path":"/same.ts"}' }]
      })
      messages.push({
        role: 'tool',
        content: `output-${i}-${'y'.repeat(100)}`,
        toolCallId: `tc_${i}`
      })
    }
    const { messages: out, provenance } = applyContextBudget(messages)
    assertPairing(out)
    expect(Object.values(provenance).some(p => p === 'superseded_removed')).toBe(true)
  })

  it('ContextBudgetManager.apply 可复用', () => {
    const mgr = new ContextBudgetManager()
    const ctx = buildLongToolContext(10, 100)
    const a = mgr.apply(ctx)
    const b = mgr.apply(ctx)
    expect(a.length).toBe(b.length)
    assertPairing(a)
  })

  it('硬预算：maxSerializedBytes 触发 hard trim，配对合法；仍超限则明确 exceeded', () => {
    const ctx = buildLongToolContext(20, 50_000)
    const { messages, exceededHardBudget, serializedBytes, provenance } = applyContextBudget(ctx, {
      maxSerializedBytes: 80_000,
      minRecentMessages: 6
    })
    assertPairing(messages)
    expect(serializedBytes).toBeDefined()
    // 必须尝试硬裁剪；若保护区仍撑破上限则 exceededHardBudget=true（不得静默超限发送）
    expect(
      Object.values(provenance).some(p => p === 'budget_hard_trim') || exceededHardBudget === true
    ).toBe(true)
    if (!exceededHardBudget) {
      expect(serializedBytes!).toBeLessThanOrEqual(80_000 * 1.05)
    }
  })
})
