/**
 * projectRequestMessages 归档逻辑测试
 */
import { describe, it, expect } from 'vitest'
import {
  projectRequestMessages,
  ACTIVE_TOOL_RESULT_MAX_TOKENS,
  isArchivedPlaceholder,
  buildArchiveContentPreview,
  createRequestProjectionArchiveCache,
  resolveRequestProjectionPolicy,
  DISABLED_PRUNE_POLICY,
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
      archiveCache: createRequestProjectionArchiveCache(),
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
      archiveCache: createRequestProjectionArchiveCache(),
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
      archiveCache: createRequestProjectionArchiveCache(),
      archive: async () => null
    })
    expect(result.messages[0].content).toBe(messages[0].content)
    expect(result.diagnostics.archiveFailures).toBe(1)
    expect(result.diagnostics.prunedCount).toBe(0)
  })

  it('同一 turn 重投影权威原文时复用稳定占位符', async () => {
    const messages: ChatMessage[] = [
      { role: 'tool', content: 'x'.repeat(18 * 1024), toolCallId: 'tc1' }
    ]
    let archiveCallCount = 0
    const archiveCache = createRequestProjectionArchiveCache()
    const first = await projectRequestMessages({
      messages,
      toolRound: 1,
      policy: { enabled: true },
      archiveCache,
      archive: async () => {
        archiveCallCount++
        return { artifactId: `art${archiveCallCount}` }
      }
    })
    const second = await projectRequestMessages({
      messages,
      toolRound: 2,
      policy: { enabled: true },
      archiveCache,
      archive: async () => {
        archiveCallCount++
        return { artifactId: `art${archiveCallCount}` }
      }
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
      archiveCache: createRequestProjectionArchiveCache(),
      archive: async () => ({ artifactId: 'art1' })
    })
    expect(result.messages[0].content).toBe('x'.repeat(100))
    expect(result.diagnostics.prunedCount).toBe(0)
  })

  it('占位符 JSON 包含正确的 sha256、originalBytes 与 preview', async () => {
    const headAndMid = Array.from({ length: 20 }, (_, i) => `line-${i + 1}`)
    const fullBody = `${headAndMid.join('\n')}\n${'x'.repeat(18 * 1024)}`
    const messages: ChatMessage[] = [
      { role: 'tool', content: fullBody, toolCallId: 'tc1' }
    ]
    const result = await projectRequestMessages({
      messages,
      toolRound: 1,
      policy: { enabled: true },
      archiveCache: createRequestProjectionArchiveCache(),
      archive: async () => ({ artifactId: 'art1' })
    })
    const parsed = JSON.parse(result.messages[0].content as string) as ArchivedToolResultPlaceholder
    const expectedSha256 = createHash('sha256').update(fullBody, 'utf8').digest('hex')
    expect(parsed.sha256).toBe(expectedSha256)
    expect(parsed.originalBytes).toBe(Buffer.byteLength(fullBody, 'utf8'))
    const previewLines = parsed.preview.split('\n')
    expect(previewLines.slice(0, 3)).toEqual(['line-1', 'line-2', 'line-3'])
    expect(previewLines[3]).toBe('…')
    expect(previewLines.slice(-2)).toEqual(
      fullBody.split('\n').slice(-2)
    )
    expect(parsed.resourceRef).toContain(`sha256=${expectedSha256}`)
  })

  it('短正文 preview 退回全文且不含省略标记', () => {
    const short = 'a\nb\nc'
    expect(buildArchiveContentPreview(short)).toBe(short)
    expect(buildArchiveContentPreview(short)).not.toContain('…')
  })

  it('preview 取前 3 行与后 2 行', () => {
    const body = ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7'].join('\n')
    expect(buildArchiveContentPreview(body)).toBe('L1\nL2\nL3\n…\nL6\nL7')
  })

  it('无 archive_read 时投影归档策略关闭', () => {
    expect(resolveRequestProjectionPolicy(false)).toEqual(DISABLED_PRUNE_POLICY)
    expect(resolveRequestProjectionPolicy(true)).toEqual({ enabled: true })
  })

  it('无 archive_read 策略时超大工具结果不产生归档占位符', async () => {
    const messages: ChatMessage[] = [
      { role: 'tool', content: 'x'.repeat(18 * 1024), toolCallId: 'tc1' }
    ]
    let archiveCalls = 0
    const result = await projectRequestMessages({
      messages,
      toolRound: 1,
      policy: resolveRequestProjectionPolicy(false),
      archiveCache: createRequestProjectionArchiveCache(),
      archive: async () => {
        archiveCalls++
        return { artifactId: 'art1' }
      }
    })
    expect(archiveCalls).toBe(0)
    expect(result.messages[0].content).toBe(messages[0].content)
    expect(result.diagnostics.prunedCount).toBe(0)
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
      archiveCache: createRequestProjectionArchiveCache(),
      archive: async () => ({ artifactId: 'art1' })
    })
    expect(result.messages[0]).toEqual(messages[0])
    expect(result.messages[1]).toEqual(messages[1])
    expect(isArchivedPlaceholder(result.messages[2].content as string)).toBe(true)
    expect(result.diagnostics.prunedCount).toBe(1)
  })
})
