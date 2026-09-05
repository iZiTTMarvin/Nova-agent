/**
 * projectRequestMessages 归档逻辑测试
 */
import { describe, it, expect } from 'vitest'
import {
  projectRequestMessages,
  freezeToolDelivery,
  ACTIVE_TOOL_RESULT_MAX_TOKENS,
  SUPERSEDED_MIN_ESTIMATED_TOKENS,
  CHARS_PER_TOKEN,
  isArchivedPlaceholder,
  buildArchiveContentPreview,
  createRequestProjectionArchiveCache,
  resolveRequestProjectionPolicy,
  DISABLED_PRUNE_POLICY,
  type ArchivedToolResultPlaceholder
} from '../../../../src/runtime/request-projection'
import type { ChatMessage } from '../../../../src/runtime/model/types'
import { createHash } from 'crypto'
import { mkdtempSync, readdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ArtifactStore } from '../../../../src/runtime/artifacts/ArtifactStore'

describe('projectRequestMessages archiving', () => {
  it.each([false, true])('首发决定跨新投影保留，首次归档成功=%s', async success => {
    const body = '中文结果\n'.repeat(3000)
    const input = { messages: [], policy: { enabled: true }, archiveCache: createRequestProjectionArchiveCache(), archive: async () => success ? { artifactId: 'stable' } : null }
    const original: ChatMessage = { role: 'tool', toolCallId: 'old', content: body }
    const frozen = await freezeToolDelivery(input, original)
    const first = await projectRequestMessages({ ...input, messages: [frozen] })
    const next = await projectRequestMessages({ ...input, archiveCache: createRequestProjectionArchiveCache(), archive: async () => ({ artifactId: 'later' }), messages: [
      { role: 'assistant', content: '', toolCalls: [{ id: 'old', name: 'read', arguments: '{"path":"a"}' }] }, frozen,
      { role: 'assistant', content: '', toolCalls: [{ id: 'new', name: 'read', arguments: '{"path":"a"}' }] }, { ...original, toolCallId: 'new' }
    ] })
    expect(next.messages[1].content).toBe(first.messages[0].content)
    expect(frozen.content).toBe(body)
    expect(frozen.toolDelivery?.kind).toBe(success ? 'archive' : 'original')
    expect(isArchivedPlaceholder(String(first.messages[0].content))).toBe(success)
  })
  it('18KB 的工具输出经投影后变为占位符，原消息未被 mutate', async () => {
    const original = 'x'.repeat(18 * 1024)
    const messages: ChatMessage[] = [
      { role: 'tool', content: original, toolCallId: 'tc1' }
    ]
    const result = await projectRequestMessages({
      messages,
      policy: { enabled: true },
      archiveCache: createRequestProjectionArchiveCache(),
      archive: async () => ({ artifactId: 'art1' })
    })
    expect(isArchivedPlaceholder(result.messages[0].content as string)).toBe(true)
    expect(messages[0].content).toBe(original)
    expect(result.diagnostics.prunedCount).toBe(1)
    const projected = result.messages[0].content as string
    expect(Buffer.byteLength(projected, 'utf8')).toBeLessThan(
      Buffer.byteLength(original, 'utf8')
    )
    expect(result.diagnostics.estimatedTokensSaved).toBeGreaterThan(0)
  })

  it('占位符 wire 内容不小于原文时保留权威结果', async () => {
    const original = 'x'.repeat(9_000)
    const result = await projectRequestMessages({
      messages: [{ role: 'tool', content: original, toolCallId: 'tc-large-meta' }],
      policy: { enabled: true },
      archiveCache: createRequestProjectionArchiveCache(),
      archive: async () => ({ artifactId: 'a'.repeat(20_000) })
    })
    expect(result.messages[0]?.content).toBe(original)
    expect(result.diagnostics.prunedCount).toBe(0)
    expect(result.diagnostics.estimatedTokensSaved).toBe(0)
  })

  it('超过阈值的工具结果在任何轮次都归档', async () => {
    const messages: ChatMessage[] = [
      { role: 'tool', content: 'x'.repeat(18 * 1024), toolCallId: 'tc1' }
    ]
    const result = await projectRequestMessages({
      messages,
      policy: { enabled: true },
      archiveCache: createRequestProjectionArchiveCache(),
      archive: async () => ({ artifactId: 'art1' })
    })
    expect(isArchivedPlaceholder(result.messages[0].content as string)).toBe(true)
    expect(result.diagnostics.prunedCount).toBe(1)
    expect(messages[0].content).toBe('x'.repeat(18 * 1024))
  })

  it('artifact 写入失败时保留原文且不抛异常', async () => {
    const messages: ChatMessage[] = [
      { role: 'tool', content: 'x'.repeat(18 * 1024), toolCallId: 'tc1' }
    ]
    const result = await projectRequestMessages({
      messages,
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
      policy: { enabled: true },
      archiveCache,
      archive: async () => {
        archiveCallCount++
        return { artifactId: `art${archiveCallCount}` }
      }
    })
    const second = await projectRequestMessages({
      messages,
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

  it('跨 turn 使用新投影缓存时仍复用同一可回读占位符', async () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'nova-projection-artifact-'))
    const store = new ArtifactStore(sessionsDir)
    const sessionId = 'projection-session'
    const messages: ChatMessage[] = [
      { role: 'tool', content: 'x'.repeat(18 * 1024), toolCallId: 'tc1' }
    ]
    const archive = async (candidate: { body: string; toolName: string }) => {
      const meta = await store.writeContentAddressed(sessionId, candidate.body, {
        toolName: candidate.toolName
      })
      return { artifactId: meta.id }
    }

    try {
      const first = await projectRequestMessages({
        messages,
        policy: { enabled: true },
        archiveCache: createRequestProjectionArchiveCache(),
        archive
      })
      const second = await projectRequestMessages({
        messages,
        policy: { enabled: true },
        archiveCache: createRequestProjectionArchiveCache(),
        archive
      })

      expect(second.messages).toEqual(first.messages)
      expect(readdirSync(store.getArtifactsDir(sessionId))).toHaveLength(1)
    } finally {
      rmSync(sessionsDir, { recursive: true, force: true })
    }
  })

  it('阈值以下的输出不归档', async () => {
    const messages: ChatMessage[] = [
      { role: 'tool', content: 'x'.repeat(100), toolCallId: 'tc1' }
    ]
    const result = await projectRequestMessages({
      messages,
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
      policy: { enabled: true },
      archiveCache: createRequestProjectionArchiveCache(),
      archive: async () => ({ artifactId: 'art1' })
    })
    const parsed = JSON.parse(result.messages[0].content as string) as ArchivedToolResultPlaceholder
    const expectedSha256 = createHash('sha256').update(fullBody, 'utf8').digest('hex')
    expect(parsed.sha256).toBe(expectedSha256)
    expect(parsed.originalBytes).toBe(Buffer.byteLength(fullBody, 'utf8'))
    expect(parsed.preview.startsWith('line-1\nline-2\nline-3\n…\n')).toBe(true)
    expect(parsed.preview.endsWith('x'.repeat(398))).toBe(true)
    expect(parsed.preview.length).toBeLessThanOrEqual(800)
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

describe('projectRequestMessages supersession 集成', () => {
  function asst(id: string, name: string, args: string): ChatMessage {
    return { role: 'assistant', content: '', toolCalls: [{ id, name, arguments: args }] }
  }

  // 多行长正文：preview（头 3 + 尾 2 行）远小于全文，确保占位符净节省 token。
  function multilineBig(lines = 80): string {
    return Array.from({ length: lines }, (_, i) => `${i + 1}: ${'y'.repeat(50)}`).join('\n')
  }

  it('两次相同大 read：第一次变占位符(superseded)，第二次保留原文，输入未被 mutate', async () => {
    const big = multilineBig()
    const messages: ChatMessage[] = [
      asst('r1', 'read', JSON.stringify({ file_path: 'a' })),
      { role: 'tool', content: big, toolCallId: 'r1' },
      asst('r2', 'read', JSON.stringify({ file_path: 'a' })),
      { role: 'tool', content: big, toolCallId: 'r2' }
    ]
    const result = await projectRequestMessages({
      messages,
      policy: { enabled: true },
      archiveCache: createRequestProjectionArchiveCache(),
      archive: async () => ({ artifactId: 'art1' })
    })
    expect(isArchivedPlaceholder(result.messages[1].content as string)).toBe(true)
    const parsed = JSON.parse(result.messages[1].content as string) as ArchivedToolResultPlaceholder
    expect(parsed.reason).toBe('superseded_by_newer_result')
    expect(result.messages[3].content).toBe(big)
    expect(result.diagnostics.prunedCount).toBe(1)
    expect(result.diagnostics.estimatedTokensSaved).toBeGreaterThan(0)
    // 权威原文未被 mutate
    expect(messages[1].content).toBe(big)
    expect(messages[3].content).toBe(big)
  })

  it('supersession 候选但原文不足阈值时不归档（占位符可能更大）', async () => {
    const small = 'x'.repeat(SUPERSEDED_MIN_ESTIMATED_TOKENS * CHARS_PER_TOKEN - 4)
    expect(small.length).toBeLessThan(SUPERSEDED_MIN_ESTIMATED_TOKENS * CHARS_PER_TOKEN)
    const messages: ChatMessage[] = [
      asst('r1', 'read', JSON.stringify({ file_path: 'a' })),
      { role: 'tool', content: small, toolCallId: 'r1' },
      asst('r2', 'read', JSON.stringify({ file_path: 'a' })),
      { role: 'tool', content: small, toolCallId: 'r2' }
    ]
    const result = await projectRequestMessages({
      messages,
      policy: { enabled: true },
      archiveCache: createRequestProjectionArchiveCache(),
      archive: async () => ({ artifactId: 'art1' })
    })
    expect(result.messages[1].content).toBe(small)
    expect(result.messages[3].content).toBe(small)
    expect(result.diagnostics.prunedCount).toBe(0)
    expect(result.diagnostics.archiveFailures).toBe(0)
  })

  it('archive 回调失败时 supersession 候选保留原文、不抛异常', async () => {
    const big = multilineBig()
    const messages: ChatMessage[] = [
      asst('r1', 'read', JSON.stringify({ file_path: 'a' })),
      { role: 'tool', content: big, toolCallId: 'r1' },
      asst('r2', 'read', JSON.stringify({ file_path: 'a' })),
      { role: 'tool', content: big, toolCallId: 'r2' }
    ]
    const result = await projectRequestMessages({
      messages,
      policy: { enabled: true },
      archiveCache: createRequestProjectionArchiveCache(),
      archive: async () => null
    })
    expect(result.messages[1].content).toBe(big)
    expect(result.messages[3].content).toBe(big)
    expect(result.diagnostics.archiveFailures).toBe(1)
    expect(result.diagnostics.prunedCount).toBe(0)
  })

  it('幂等：对已含占位符的消息再投影，不二次归档', async () => {
    const big = multilineBig()
    const messages: ChatMessage[] = [
      asst('r1', 'read', JSON.stringify({ file_path: 'a' })),
      { role: 'tool', content: big, toolCallId: 'r1' },
      asst('r2', 'read', JSON.stringify({ file_path: 'a' })),
      { role: 'tool', content: big, toolCallId: 'r2' }
    ]
    let archiveCalls = 0
    const cache = createRequestProjectionArchiveCache()
    const archive = async () => {
      archiveCalls++
      return { artifactId: `art${archiveCalls}` }
    }
    const first = await projectRequestMessages({
      messages,
      policy: { enabled: true },
      archiveCache: cache,
      archive
    })
    const second = await projectRequestMessages({
      messages: first.messages,
      policy: { enabled: true },
      archiveCache: cache,
      archive
    })
    expect(second.messages).toEqual(first.messages)
    expect(archiveCalls).toBe(1)
  })
})
