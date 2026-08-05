/**
 * projectRequestMessages 归档逻辑测试
 */
import { describe, it, expect } from 'vitest'
import {
  projectRequestMessages,
  ACTIVE_TOOL_RESULT_MAX_TOKENS,
  isArchivedPlaceholder,
  type ArchivedToolResultPlaceholder
} from '../../../../src/runtime/agent/core/projectRequestMessages'
import type { ChatMessage } from '../../../../src/runtime/model/types'
import { createHash } from 'crypto'

describe('projectRequestMessages archiving', () => {
  it('18KB 的工具输出经投影后变为占位符，原消息未被 mutate', async () => {
    const original = 'x'.repeat(18 * 1024)
    const messages: ChatMessage[] = [
      { role: 'tool', content: original, toolCallId: 'tc1' }
    ]
    const result = await projectRequestMessages({
      messages,
      toolRound: 1,
      policy: { enabled: true },
      archive: async () => ({ artifactId: 'art1' })
    })
    expect(isArchivedPlaceholder(result.messages[0].content as string)).toBe(true)
    expect(messages[0].content).toBe(original)
    expect(result.diagnostics.prunedCount).toBe(1)
  })

  it('toolRound === 0 时不归档', async () => {
    const messages: ChatMessage[] = [
      { role: 'tool', content: 'x'.repeat(18 * 1024), toolCallId: 'tc1' }
    ]
    const result = await projectRequestMessages({
      messages,
      toolRound: 0,
      policy: { enabled: true },
      archive: async () => ({ artifactId: 'art1' })
    })
    expect(result.messages).toEqual(messages)
    expect(result.diagnostics.prunedCount).toBe(0)
    expect(result.diagnostics.archiveFailures).toBe(0)
  })

  it('artifact 写入失败时保留原文且不抛异常', async () => {
    const messages: ChatMessage[] = [
      { role: 'tool', content: 'x'.repeat(18 * 1024), toolCallId: 'tc1' }
    ]
    const result = await projectRequestMessages({
      messages,
      toolRound: 1,
      policy: { enabled: true },
      archive: async () => null
    })
    expect(result.messages[0].content).toBe(messages[0].content)
    expect(result.diagnostics.archiveFailures).toBe(1)
    expect(result.diagnostics.prunedCount).toBe(0)
  })

  it('连续两次投影结果一致（幂等）', async () => {
    const messages: ChatMessage[] = [
      { role: 'tool', content: 'x'.repeat(18 * 1024), toolCallId: 'tc1' }
    ]
    let archiveCallCount = 0
    const first = await projectRequestMessages({
      messages,
      toolRound: 1,
      policy: { enabled: true },
      archive: async () => { archiveCallCount++; return { artifactId: 'art1' } }
    })
    const second = await projectRequestMessages({
      messages: first.messages,
      toolRound: 1,
      policy: { enabled: true },
      archive: async () => { archiveCallCount++; return { artifactId: 'art1' } }
    })
    expect(second.messages).toEqual(first.messages)
    expect(archiveCallCount).toBe(1)
  })

  it('阈值以下的输出不归档', async () => {
    const messages: ChatMessage[] = [
      { role: 'tool', content: 'x'.repeat(100), toolCallId: 'tc1' }
    ]
    const result = await projectRequestMessages({
      messages,
      toolRound: 1,
      policy: { enabled: true },
      archive: async () => ({ artifactId: 'art1' })
    })
    expect(result.messages[0].content).toBe('x'.repeat(100))
    expect(result.diagnostics.prunedCount).toBe(0)
  })

  it('占位符 JSON 包含正确的 sha256 和 originalBytes', async () => {
    const body = 'x'.repeat(18 * 1024)
    const messages: ChatMessage[] = [
      { role: 'tool', content: body, toolCallId: 'tc1' }
    ]
    const result = await projectRequestMessages({
      messages,
      toolRound: 1,
      policy: { enabled: true },
      archive: async () => ({ artifactId: 'art1' })
    })
    const parsed = JSON.parse(result.messages[0].content as string) as ArchivedToolResultPlaceholder
    const expectedSha256 = createHash('sha256').update(body, 'utf8').digest('hex')
    expect(parsed.sha256).toBe(expectedSha256)
    expect(parsed.originalBytes).toBe(18 * 1024)
  })

  it('非 tool 角色消息不被归档', async () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
      { role: 'tool', content: 'x'.repeat(18 * 1024), toolCallId: 'tc1' }
    ]
    const result = await projectRequestMessages({
      messages,
      toolRound: 1,
      policy: { enabled: true },
      archive: async () => ({ artifactId: 'art1' })
    })
    expect(result.messages[0]).toEqual(messages[0])
    expect(result.messages[1]).toEqual(messages[1])
    expect(isArchivedPlaceholder(result.messages[2].content as string)).toBe(true)
    expect(result.diagnostics.prunedCount).toBe(1)
  })
})
