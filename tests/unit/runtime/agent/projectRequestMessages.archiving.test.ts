/**
 * projectRequestMessages 归档逻辑测试
 */
import { describe, it, expect } from 'vitest'
import {
  projectRequestMessages,
  SUPERSEDED_MIN_ESTIMATED_TOKENS,
  CHARS_PER_TOKEN,
  isArchivedPlaceholder,
  buildArchiveContentPreview,
  createRequestProjectionArchiveCache,
  resolveRequestProjectionPolicy,
  DISABLED_PRUNE_POLICY,
  type ArchivedToolResultPlaceholder
} from '../../../../src/runtime/request-projection'
import type { ChatMessage, ContentBlock } from '../../../../src/runtime/model/types'
import { createHash } from 'crypto'
import { mkdtempSync, readdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ArtifactStore } from '../../../../src/runtime/artifacts/ArtifactStore'

describe('projectRequestMessages archiving', () => {
  it.each([true, false])('首次归档成败决定投递与冻结，归档成功=%s', async success => {
    const body = '中文结果\n'.repeat(3000)
    const original: ChatMessage = { role: 'tool', toolCallId: 'old', content: body }
    const input = {
      policy: { enabled: true },
      archiveCache: createRequestProjectionArchiveCache(),
      archive: async () => (success ? { artifactId: 'stable' } : null)
    }
    const first = await projectRequestMessages({ ...input, messages: [original] })
    expect(isArchivedPlaceholder(String(first.messages[0].content))).toBe(success)
    expect(first.frozenDeliveries).toHaveLength(success ? 1 : 0)
    // 调用方（runAgentLoop）写回冻结投递后再投影：幂等复用同一占位符
    for (const { toolCallId, delivery } of first.frozenDeliveries) {
      if (toolCallId === 'old') original.toolDelivery = delivery
    }
    const second = await projectRequestMessages({
      ...input,
      archiveCache: createRequestProjectionArchiveCache(),
      archive: async () => ({ artifactId: 'later' }),
      messages: [original]
    })
    if (success) {
      expect(second.messages[0].content).toBe(first.messages[0].content)
      expect(second.frozenDeliveries).toHaveLength(0)
    } else {
      // 归档失败不冻结为永久原文：下次投影重试归档
      expect(isArchivedPlaceholder(String(second.messages[0].content))).toBe(true)
      expect(second.diagnostics.archiveFailures + second.diagnostics.prunedCount).toBe(1)
    }
    expect(original.content).toBe(body)
  })

  it('延后集合命中的超阈值结果全文投递且不产生冻结投递', async () => {
    const body = 'x'.repeat(18 * 1024)
    let archiveCalls = 0
    const result = await projectRequestMessages({
      messages: [{ role: 'tool', content: body, toolCallId: 'tc1' }],
      policy: { enabled: true },
      archiveCache: createRequestProjectionArchiveCache(),
      archive: async () => {
        archiveCalls++
        return { artifactId: 'art1' }
      },
      deferToolCallIds: new Set(['tc1'])
    })
    expect(result.messages[0].content).toBe(body)
    expect(archiveCalls).toBe(0)
    expect(result.diagnostics.prunedCount).toBe(0)
    expect(result.frozenDeliveries).toHaveLength(0)
  })

  it('延后集合命中的结果不归档，同批更早的重复结果仍被 supersede 归档', async () => {
    const big = Array.from({ length: 80 }, (_, i) => `${i + 1}: ${'y'.repeat(50)}`).join('\n')
    const messages: ChatMessage[] = [
      { role: 'assistant', content: '', toolCalls: [{ id: 'r1', name: 'read', arguments: JSON.stringify({ file_path: 'a' }) }] },
      { role: 'tool', content: big, toolCallId: 'r1' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'r2', name: 'read', arguments: JSON.stringify({ file_path: 'a' }) }] },
      { role: 'tool', content: big, toolCallId: 'r2' }
    ]
    const result = await projectRequestMessages({
      messages,
      policy: { enabled: true },
      archiveCache: createRequestProjectionArchiveCache(),
      archive: async () => ({ artifactId: 'art1' }),
      deferToolCallIds: new Set(['r2'])
    })
    // r1 已被 r2 覆盖：即使 r2 在延后集合，r1 仍归档
    expect(isArchivedPlaceholder(result.messages[1].content as string)).toBe(true)
    const parsed = JSON.parse(result.messages[1].content as string) as ArchivedToolResultPlaceholder
    expect(parsed.reason).toBe('superseded_by_newer_result')
    // r2 命中延后集合：全文投递
    expect(result.messages[3].content).toBe(big)
    expect(result.frozenDeliveries.map(f => f.toolCallId)).toEqual(['r1'])
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

  it('超过阈值且不在延后集合的工具结果归档', async () => {
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

  it('无 archive_read 时策略关闭；开启时按上下文窗口给出保护窗口与批量门槛', () => {
    expect(resolveRequestProjectionPolicy(false, 200_000)).toEqual(DISABLED_PRUNE_POLICY)
    expect(resolveRequestProjectionPolicy(true, 200_000)).toEqual({
      enabled: true,
      protectRecentTokens: 40_000,
      minSavingsTokens: 20_000
    })
    expect(resolveRequestProjectionPolicy(true, 32_000)).toEqual({
      enabled: true,
      protectRecentTokens: 6_400,
      minSavingsTokens: 3_200
    })
  })

  it('无 archive_read 策略时超大工具结果不产生归档占位符', async () => {
    const messages: ChatMessage[] = [
      { role: 'tool', content: 'x'.repeat(18 * 1024), toolCallId: 'tc1' }
    ]
    let archiveCalls = 0
    const result = await projectRequestMessages({
      messages,
      policy: resolveRequestProjectionPolicy(false, 200_000),
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

describe('深位 superseded 守卫', () => {
  function asst(id: string, name: string, args: string): ChatMessage {
    return { role: 'assistant', content: '', toolCalls: [{ id, name, arguments: args }] }
  }

  /** 让指定位置之后的投递后缀超过守卫阈值（8k token ≈ 32K 字符） */
  function deepSuffix(): ChatMessage[] {
    // 6 条约 6KB 的未覆盖工具结果 ≈ 9k+ token
    return Array.from({ length: 6 }, (_, i) => ({
      role: 'tool' as const,
      toolCallId: `f${i}`,
      content: `f${i}:\n${'z'.repeat(6_000)}`
    }))
  }

  it('深位纯 superseded 候选保留原文、不归档、不产生冻结投递', async () => {
    const big = 't\n' + 'x'.repeat(2_000)
    const messages: ChatMessage[] = [
      asst('r1', 'read', JSON.stringify({ file_path: 'a' })),
      { role: 'tool', content: big, toolCallId: 'r1' },
      ...deepSuffix(),
      asst('r2', 'read', JSON.stringify({ file_path: 'a' })),
      { role: 'tool', content: big, toolCallId: 'r2' }
    ]
    let archiveCalls = 0
    const result = await projectRequestMessages({
      messages,
      policy: { enabled: true },
      archiveCache: createRequestProjectionArchiveCache(),
      archive: async () => { archiveCalls++; return { artifactId: 'art1' } }
    })
    // 守卫：r1 保持全文投递；r2 是最新覆盖者，不在计划内
    expect(result.messages[1].content).toBe(big)
    expect(result.frozenDeliveries).toHaveLength(0)
    expect(archiveCalls).toBe(0)
    expect(result.diagnostics.prunedCount).toBe(0)
  })

  it('同一候选移到尾部（后缀不足阈值）仍正常归档', async () => {
    const big = 't\n' + 'x'.repeat(2_000)
    const messages: ChatMessage[] = [
      ...deepSuffix(),
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
    expect(isArchivedPlaceholder(result.messages[7].content as string)).toBe(true)
    expect(result.frozenDeliveries.map(f => f.toolCallId)).toEqual(['r1'])
  })

  it('双重命中（superseded + 超体积阈值）深位仍按体积归档放行', async () => {
    const huge = 'h\n' + 'x'.repeat(20_000) // >2048 token 体积阈值
    const messages: ChatMessage[] = [
      asst('r1', 'read', JSON.stringify({ file_path: 'a' })),
      { role: 'tool', content: huge, toolCallId: 'r1' },
      ...deepSuffix(),
      asst('r2', 'read', JSON.stringify({ file_path: 'a' })),
      { role: 'tool', content: huge, toolCallId: 'r2' }
    ]
    const result = await projectRequestMessages({
      messages,
      policy: { enabled: true },
      archiveCache: createRequestProjectionArchiveCache(),
      archive: async () => ({ artifactId: 'art1' })
    })
    expect(isArchivedPlaceholder(result.messages[1].content as string)).toBe(true)
    // r2 的覆盖结果本身也超体积阈值，同请求内按体积归档
    expect(result.frozenDeliveries.map(f => f.toolCallId)).toEqual(['r1', 'r2'])
  })

  it('已冻结占位符的深位消息不被守卫复活（幂等复用）', async () => {
    const big = 't\n' + 'x'.repeat(2_000)
    const frozen: ChatMessage = {
      role: 'tool',
      toolCallId: 'r1',
      content: big,
      toolDelivery: {
        version: 1, kind: 'archive',
        bodySha256: createHash('sha256').update(big, 'utf8').digest('hex'),
        placeholder: JSON.stringify({ kind: 'nova.archived_tool_result', v: 1, artifactId: 'a1', toolCallId: 'r1', toolName: '_runtime_archived', sha256: 'x'.repeat(64), originalBytes: 2002, originalEstimatedTokens: 500, preview: 't', reason: 'superseded_by_newer_result', readInstructions: 'archive_read', resourceRef: 'artifact://a1' })
      }
    }
    const messages: ChatMessage[] = [
      asst('r1', 'read', JSON.stringify({ file_path: 'a' })),
      frozen,
      ...deepSuffix(),
      asst('r2', 'read', JSON.stringify({ file_path: 'a' })),
      { role: 'tool', content: big, toolCallId: 'r2' }
    ]
    const result = await projectRequestMessages({
      messages,
      policy: { enabled: true },
      archiveCache: createRequestProjectionArchiveCache(),
      archive: async () => { throw new Error('冻结投递不应触发归档') }
    })
    expect(result.messages[1].content).toBe(frozen.toolDelivery!.placeholder)
    expect(result.frozenDeliveries).toHaveLength(0)
  })

  it('后缀中的 reasoningContent 计入深度（无它则候选在尾部应归档）', async () => {
    const big = 't\n' + 'x'.repeat(2_000)
    const withReasoning: ChatMessage[] = [
      asst('r1', 'read', JSON.stringify({ file_path: 'a' })),
      { role: 'tool', content: big, toolCallId: 'r1' },
      { role: 'assistant', content: '短', reasoningContent: '推'.repeat(40_000) },
      asst('r2', 'read', JSON.stringify({ file_path: 'a' })),
      { role: 'tool', content: big, toolCallId: 'r2' }
    ]
    const guarded = await projectRequestMessages({
      messages: withReasoning,
      policy: { enabled: true },
      archiveCache: createRequestProjectionArchiveCache(),
      archive: async () => ({ artifactId: 'art1' })
    })
    expect(guarded.messages[1].content).toBe(big)

    const withoutReasoning = withReasoning.map(m => m.role === 'assistant' && m.reasoningContent ? { ...m, reasoningContent: undefined } : m)
    const unguarded = await projectRequestMessages({
      messages: withoutReasoning,
      policy: { enabled: true },
      archiveCache: createRequestProjectionArchiveCache(),
      archive: async () => ({ artifactId: 'art1' })
    })
    expect(isArchivedPlaceholder(unguarded.messages[1].content as string)).toBe(true)
  })

  it('后缀中的图片块按线上字节计入深度', async () => {
    const big = 't\n' + 'x'.repeat(2_000)
    const imageBlock: ContentBlock = { type: 'image_url', image_url: { url: `data:image/png;base64,${'A'.repeat(40_000)}` } }
    const messages: ChatMessage[] = [
      asst('r1', 'read', JSON.stringify({ file_path: 'a' })),
      { role: 'tool', content: big, toolCallId: 'r1' },
      { role: 'tool', toolCallId: 'shot', content: [{ type: 'text' as const, text: '截图' }, imageBlock] },
      asst('r2', 'read', JSON.stringify({ file_path: 'a' })),
      { role: 'tool', content: big, toolCallId: 'r2' }
    ]
    const result = await projectRequestMessages({
      messages,
      policy: { enabled: true },
      archiveCache: createRequestProjectionArchiveCache(),
      archive: async () => ({ artifactId: 'art1' })
    })
    expect(result.messages[1].content).toBe(big)
  })

  it('后缀中已冻结消息按占位符计入（不是原文）', async () => {
    const big = 't\n' + 'x'.repeat(2_000)
    const frozenHuge: ChatMessage = {
      role: 'tool', toolCallId: 'old',
      content: 'y'.repeat(200_000),
      toolDelivery: {
        version: 1, kind: 'archive',
        bodySha256: createHash('sha256').update('y'.repeat(200_000), 'utf8').digest('hex'),
        placeholder: JSON.stringify({ kind: 'nova.archived_tool_result', v: 1, artifactId: 'a0', toolCallId: 'old', toolName: '_runtime_archived', sha256: 'x'.repeat(64), originalBytes: 200_000, originalEstimatedTokens: 50_000, preview: 'y', reason: 'consumed_then_archived', readInstructions: 'archive_read', resourceRef: 'artifact://a0' })
      }
    }
    const messages: ChatMessage[] = [
      asst('r1', 'read', JSON.stringify({ file_path: 'a' })),
      { role: 'tool', content: big, toolCallId: 'r1' },
      frozenHuge,
      asst('r2', 'read', JSON.stringify({ file_path: 'a' })),
      { role: 'tool', content: big, toolCallId: 'r2' }
    ]
    const result = await projectRequestMessages({
      messages,
      policy: { enabled: true },
      archiveCache: createRequestProjectionArchiveCache(),
      archive: async () => ({ artifactId: 'art1' })
    })
    // 后缀只有占位符（~500B）+ 短文本 → 不足阈值 → r1 正常归档
    expect(isArchivedPlaceholder(result.messages[1].content as string)).toBe(true)
    expect(result.messages[2].content).toBe(frozenHuge.toolDelivery!.placeholder)
  })
})

describe('压力驱动归档', () => {
  function asst(id: string, name: string, args: string): ChatMessage {
    return { role: 'assistant', content: '', toolCalls: [{ id, name, arguments: args }] }
  }

  /** ~3K token 的多行正文：预览远小于全文，保证占位符为净节省 */
  function bigResult(seed: string, lines = 220): string {
    return Array.from({ length: lines }, (_, i) => `${seed}${i + 1}: ${'y'.repeat(50)}`).join('\n')
  }

  /** 让指定位置之后的投递后缀超过深位守卫阈值（8k token ≈ 32K 字符） */
  function deepSuffix(): ChatMessage[] {
    return Array.from({ length: 6 }, (_, i) => ({
      role: 'tool' as const,
      toolCallId: `f${i}`,
      content: `f${i}:\n${'z'.repeat(6_000)}`
    }))
  }

  it('超体积结果在其后投递后缀未滑出最近窗口时保留原文，滑出后归档', async () => {
    const big = 'x'.repeat(18 * 1024)
    let archiveCalls = 0
    const archive = async () => { archiveCalls++; return { artifactId: 'art1' } }
    const policy = { enabled: true, protectRecentTokens: 1_000 }

    // 后缀 ~200 token < 窗口：仍在工作集，全文投递且不归档
    const recent = await projectRequestMessages({
      messages: [
        { role: 'tool', toolCallId: 'tc1', content: big },
        { role: 'tool', toolCallId: 'tc2', content: 'y'.repeat(800) }
      ],
      policy,
      archiveCache: createRequestProjectionArchiveCache(),
      archive
    })
    expect(recent.messages[0].content).toBe(big)
    expect(recent.frozenDeliveries).toHaveLength(0)
    expect(archiveCalls).toBe(0)

    // 后缀 ~1500 token > 窗口：滑出最近工作集，归档为占位符
    const slidOut = await projectRequestMessages({
      messages: [
        { role: 'tool', toolCallId: 'tc1', content: big },
        { role: 'tool', toolCallId: 'tc2', content: 'y'.repeat(6_000) }
      ],
      policy,
      archiveCache: createRequestProjectionArchiveCache(),
      archive
    })
    expect(isArchivedPlaceholder(slidOut.messages[0].content as string)).toBe(true)
    expect(slidOut.frozenDeliveries).toHaveLength(1)
    expect(archiveCalls).toBe(1)
  })

  it('体积候选可回收总量不足门槛时全部保留原文，达标后同批归档', async () => {
    const policy = { enabled: true, minSavingsTokens: 8_000 }
    const tail: ChatMessage = { role: 'tool', toolCallId: 'tail', content: 'y'.repeat(400) }
    let archiveCalls = 0
    const archive = async () => { archiveCalls++; return { artifactId: `art${archiveCalls}` } }

    // 两条各 ~3K token 的候选合计 < 8K：本次全部保留原文
    const two = await projectRequestMessages({
      messages: [
        { role: 'tool', toolCallId: 'a1', content: bigResult('a') },
        { role: 'tool', toolCallId: 'a2', content: bigResult('b') },
        tail
      ],
      policy,
      archiveCache: createRequestProjectionArchiveCache(),
      archive
    })
    expect(two.messages[0].content).toBe(bigResult('a'))
    expect(two.messages[1].content).toBe(bigResult('b'))
    expect(two.diagnostics.prunedCount).toBe(0)
    expect(archiveCalls).toBe(0)

    // 三条合计 ≥ 8K：同一次投影里一起归档，只断一次缓存前缀
    const three = await projectRequestMessages({
      messages: [
        { role: 'tool', toolCallId: 'a1', content: bigResult('a') },
        { role: 'tool', toolCallId: 'a2', content: bigResult('b') },
        { role: 'tool', toolCallId: 'a3', content: bigResult('c') },
        tail
      ],
      policy,
      archiveCache: createRequestProjectionArchiveCache(),
      archive
    })
    expect(three.messages.slice(0, 3).every(m => isArchivedPlaceholder(m.content as string))).toBe(true)
    expect(three.frozenDeliveries.map(f => f.toolCallId)).toEqual(['a1', 'a2', 'a3'])
    expect(archiveCalls).toBe(3)
  })

  it('深位 superseded 且超体积的候选并入批量门槛，不达标时保留原文', async () => {
    const huge = 'h\n' + 'x'.repeat(20_000)
    const messages: ChatMessage[] = [
      asst('r1', 'read', JSON.stringify({ file_path: 'a' })),
      { role: 'tool', content: huge, toolCallId: 'r1' },
      ...deepSuffix(),
      asst('r2', 'read', JSON.stringify({ file_path: 'a' })),
      { role: 'tool', content: huge, toolCallId: 'r2' }
    ]
    let archiveCalls = 0
    const result = await projectRequestMessages({
      messages,
      policy: { enabled: true, minSavingsTokens: 20_000 },
      archiveCache: createRequestProjectionArchiveCache(),
      archive: async () => { archiveCalls++; return { artifactId: 'art1' } }
    })
    // r1 深位双重命中不再直接归档，与 r2 一起按可回收总量裁决；合计不足门槛 → 保留原文
    expect(result.messages[1].content).toBe(huge)
    expect(result.messages[result.messages.length - 1].content).toBe(huge)
    expect(result.frozenDeliveries).toHaveLength(0)
    expect(archiveCalls).toBe(0)
  })
})
