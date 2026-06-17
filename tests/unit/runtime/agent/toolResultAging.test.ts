/**
 * toolResultAging 单元测试
 */
import { describe, it, expect } from 'vitest'
import { extractTextFromContent } from '../../../../src/runtime/model/types'
import type { ChatMessage } from '../../../../src/runtime/model/types'
import {
  ageToolResults,
  AGING_USER_TURN_THRESHOLD,
  AGING_GROUP_BYTES_THRESHOLD,
} from '../../../../src/runtime/agent/toolResultAging'
import { MIN_RECENT_MESSAGES } from '../../../../src/runtime/agent/compaction'

/** 构造含 N 轮 user + bash 工具组的上下文 */
function buildToolGroupContext(
  userTurns: number,
  toolOutputSize: number,
  withArtifact = false
): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: 'system', content: 'system prompt' }]
  for (let u = 0; u < userTurns; u++) {
    messages.push({ role: 'user', content: `user question ${u}` })
    messages.push({
      role: 'assistant',
      content: 'running tool',
      toolCalls: [{ id: `tc_${u}`, name: 'bash', arguments: '{"command":"echo"}' }]
    })
    messages.push({
      role: 'tool',
      content: `output line 1 for turn ${u}\n${'x'.repeat(toolOutputSize)}`,
      toolCallId: `tc_${u}`,
      ...(withArtifact ? { artifactId: `art_${u}` } : {})
    })
  }
  return messages
}

/** 断言每个 assistant(toolCalls) 后仍有对应 tool 消息 */
function assertToolGroupPairing(messages: ChatMessage[]): void {
  const nonSystem = messages.filter(m => m.role !== 'system')
  for (let i = 0; i < nonSystem.length; i++) {
    const msg = nonSystem[i]
    if (msg.role === 'assistant' && msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        const toolMsg = nonSystem.find(m => m.role === 'tool' && m.toolCallId === tc.id)
        expect(toolMsg).toBeDefined()
      }
    }
  }
}

describe('toolResultAging', () => {
  it('超过 8 个 user 回合的旧工具组被压缩为单行占位', () => {
    // 35 轮确保第 9+ 组落在 MIN_RECENT_MESSAGES 保护区之外
    const context = buildToolGroupContext(35, AGING_GROUP_BYTES_THRESHOLD + 100)
    const aged = ageToolResults(context)

    const toolMessages = aged.filter(m => m.role === 'tool')
    const agedCount = toolMessages.filter(m =>
      extractTextFromContent(m.content).startsWith('[aged tool result]')
    ).length

    expect(agedCount).toBeGreaterThan(0)
    const firstAged = toolMessages.find(m =>
      extractTextFromContent(m.content).includes('[aged tool result] bash')
    )
    expect(firstAged).toBeDefined()
    expect(extractTextFromContent(firstAged!.content).length).toBeLessThan(300)
  })

  it('带 artifactId 的工具组优先老化（即使字节未超 8KB）', () => {
    const context = buildToolGroupContext(35, 100, true)
    const aged = ageToolResults(context)

    const toolAtTurn10 = aged.filter(m => m.role === 'tool')[10]
    expect(extractTextFromContent(toolAtTurn10.content)).toContain('[aged tool result]')
    expect(extractTextFromContent(toolAtTurn10.content)).toContain('artifact://art_10')
  })

  it(`最近 ${MIN_RECENT_MESSAGES} 条消息内的工具组完整保留`, () => {
    const context = buildToolGroupContext(35, AGING_GROUP_BYTES_THRESHOLD + 500, true)
    const aged = ageToolResults(context)

    const nonSystem = aged.filter(m => m.role !== 'system')
    const recentTools = nonSystem.slice(-MIN_RECENT_MESSAGES).filter(m => m.role === 'tool')
    for (const tool of recentTools) {
      expect(extractTextFromContent(tool.content)).not.toContain('[aged tool result]')
    }
  })

  it('aging 后 assistant.toolCalls 与 tool 消息配对完整', () => {
    const context = buildToolGroupContext(20, AGING_GROUP_BYTES_THRESHOLD + 200)
    const aged = ageToolResults(context)
    assertToolGroupPairing(aged)
  })

  it('年龄未超过阈值且字节/artifact 均不满足时不老化', () => {
    // 仅 5 轮，旧组 userTurnsBefore 最大为 4，不超过 AGING_USER_TURN_THRESHOLD
    const context = buildToolGroupContext(5, AGING_GROUP_BYTES_THRESHOLD + 500, false)
    const aged = ageToolResults(context)
    const anyAged = aged.some(m =>
      m.role === 'tool' && extractTextFromContent(m.content).includes('[aged tool result]')
    )
    expect(anyAged).toBe(false)
  })

  it(`user 回合数 > ${AGING_USER_TURN_THRESHOLD} 且位于保护区外时老化`, () => {
    const context = buildToolGroupContext(35, AGING_GROUP_BYTES_THRESHOLD + 100)
    const aged = ageToolResults(context)
    // turn 9：起始前有 9 个 user，且 groupStart 落在 splitIndex 之前
    const tool9 = aged.filter(m => m.role === 'tool')[9]
    expect(extractTextFromContent(tool9.content)).toContain('[aged tool result]')
    // turn 0：起始前仅 1 个 user，不应老化
    const tool0 = aged.filter(m => m.role === 'tool')[0]
    expect(extractTextFromContent(tool0.content)).not.toContain('[aged tool result]')
  })
})
