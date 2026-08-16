import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'crypto'
import { CacheDiagnostics } from '../../../../src/runtime/model/cacheDiagnostics'
import type { ChatEvent, ChatMessage } from '../../../../src/runtime/model/types'
import { extractTextFromContent } from '../../../../src/runtime/model/types'
import { defaultContextBudgetManager } from '../../../../src/runtime/agent/ContextBudgetManager'
import { CompactionService } from '../../../../src/runtime/agent/compaction/CompactionService'
import {
  MIN_RECENT_MESSAGES,
  MAX_SUMMARY_ESTIMATED_TOKENS,
  splitForCompaction
} from '../../../../src/runtime/agent/compaction/compaction'
import {
  createSummaryProjection
} from '../../../../src/runtime/agent/core/runAgentLoop'
import {
  ACTIVE_TOOL_RESULT_MAX_TOKENS,
  createRequestProjectionArchiveCache,
  isArchivedPlaceholder
} from '../../../../src/runtime/agent/core/projectRequestMessages'
import { CHARS_PER_TOKEN } from '../../../../src/runtime/agent/tokenEstimator'
import {
  createAgentContext,
  type AgentContext
} from '../../../../src/runtime/agent/core/AgentContext'
import type { CompactionMeta } from '../../../../src/runtime/agent/types'
import { createReadState } from '../../../../src/runtime/tools/editTool'
import type { ArtifactStore } from '../../../../src/runtime/artifacts/ArtifactStore'
import { MockModelClient } from '../../../../src/test-support/builders/MockModelClient'
import { identitySummaryProjection } from '../../../../src/test-support/builders/identitySummaryProjection'

function createMessages(count = 30, contentLength = 80): ChatMessage[] {
  return [
    { role: 'system', content: 'system prompt' },
    ...Array.from({ length: count }, (_, index): ChatMessage => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `message-${index}-${'x'.repeat(contentLength)}`
    }))
  ]
}

function createContext(messages: ChatMessage[]): AgentContext {
  return createAgentContext({
    readState: createReadState(),
    messages,
    systemPrompt: 'system prompt'
  })
}

function createService(options: {
  context: AgentContext
  client: MockModelClient
  onCompaction?: (context: ChatMessage[], meta: CompactionMeta) => void
  promptCacheKey?: string
}): {
  service: CompactionService
  context: AgentContext
  client: MockModelClient
  cacheDiagnostics: CacheDiagnostics
} {
  const cacheDiagnostics = new CacheDiagnostics()
  const service = new CompactionService({
    context: options.context,
    modelClient: options.client,
    contextBudgetManager: defaultContextBudgetManager,
    cacheDiagnostics,
    contextWindow: 100,
    onCompaction: options.onCompaction,
    getIdleCacheProfile: () => ({ idlePolicy: 'anthropic-short-ttl' }),
    idleProjection: identitySummaryProjection,
    ...(options.promptCacheKey ? { promptCacheKey: options.promptCacheKey } : {})
  })
  return { service, context: options.context, client: options.client, cacheDiagnostics }
}

function summaryResponse(text: string): { events: ChatEvent[] } {
  return {
    events: [
      { type: 'text_delta', delta: text },
      { type: 'message_end', finishReason: 'stop' }
    ]
  }
}

/** 大工具结果 + reasoning 的历史：被压缩区域落在带归档占位符与 reasoning 回放的范围内 */
function createProjectedHistoryFixture(): ChatMessage[] {
  const bigResult = 'x'.repeat(ACTIVE_TOOL_RESULT_MAX_TOKENS * CHARS_PER_TOKEN + 500)
  const nonSystem: ChatMessage[] = [
    { role: 'user', content: '请读取 data.txt' },
    {
      role: 'assistant',
      content: '',
      reasoningContent: '先读文件再总结',
      reasoningProviderId: 'deepseek',
      toolCalls: [{ id: 'call-big', name: 'read', arguments: '{"path":"data.txt"}' }]
    },
    { role: 'tool', content: bigResult, toolCallId: 'call-big' },
    ...Array.from({ length: 27 }, (_, index): ChatMessage => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `filler-${index}-${'y'.repeat(60)}`
    }))
  ]
  return [{ role: 'system', content: 'system prompt' }, ...nonSystem]
}

describe('压缩摘要质量协议', () => {
  it('摘要 + 保留区不小于压缩前总量时拒绝采纳（fail-open）', async () => {
    const original = createMessages()
    const context = createContext(original)
    context.compactionLevel = 1
    context.userTurnsSinceCompaction = 4
    const onCompaction = vi.fn()
    // 被折叠的 oldMessages 约 900 字符（≈225 估算 token），摘要明显更大
    const client = new MockModelClient().addResponse(summaryResponse('冗长摘要\n' + 's'.repeat(2000)))
    const { service, cacheDiagnostics } = createService({ context, client, onCompaction })

    await expect(service.runThresholdCompaction(identitySummaryProjection)).resolves.toBe(false)

    expect(context.messages).toBe(original)
    expect(context.compactionLevel).toBe(1)
    expect(context.userTurnsSinceCompaction).toBe(4)
    expect(cacheDiagnostics.getEpochReason()).toBe('session_init')
    expect(onCompaction).not.toHaveBeenCalled()
  })

  it('overflow 路径同样 fail-open：拒绝时不改写上下文', async () => {
    const original = createMessages(32)
    const context = createContext(original)
    const onCompaction = vi.fn()
    const client = new MockModelClient().addResponse(summaryResponse('o'.repeat(2000)))
    const { service } = createService({ context, client, onCompaction })

    await expect(service.runOverflowCompaction('standard', identitySummaryProjection)).resolves.toBe(false)

    expect(context.messages).toBe(original)
    expect(context.compactionLevel).toBe(0)
    expect(onCompaction).not.toHaveBeenCalled()
  })

  it('摘要足够小时正常采纳并通知', async () => {
    const original = createMessages()
    const context = createContext(original)
    const onCompaction = vi.fn()
    const client = new MockModelClient().addResponse(summaryResponse('简短摘要'))
    const { service } = createService({ context, client, onCompaction })

    await expect(service.runThresholdCompaction(identitySummaryProjection)).resolves.toBe(true)

    expect(extractTextFromContent(context.messages[0].content)).toContain('简短摘要')
    expect(context.messages.slice(1)).toEqual(original.slice(-20))
    expect(context.compactionLevel).toBe(1)
    expect(context.userTurnsSinceCompaction).toBe(0)
    expect(onCompaction).toHaveBeenCalledWith(context.messages, {
      summary: '简短摘要',
      compactionLevel: 1,
      trigger: 'threshold'
    })
  })

  it('超过估算上限的摘要截断后正常采纳', async () => {
    // 长消息让 oldMessages 明显大于 768 估算 token，截断后的摘要仍有压缩收益
    const context = createContext(createMessages(30, 500))
    const onCompaction = vi.fn()
    const hugeSummary = 'h'.repeat(MAX_SUMMARY_ESTIMATED_TOKENS * CHARS_PER_TOKEN + 2000)
    const client = new MockModelClient().addResponse(summaryResponse(hugeSummary))
    const { service } = createService({ context, client, onCompaction })

    await expect(service.runThresholdCompaction(identitySummaryProjection)).resolves.toBe(true)

    const boundedLength = MAX_SUMMARY_ESTIMATED_TOKENS * CHARS_PER_TOKEN + '\n…[摘要已截断]'.length
    const meta = onCompaction.mock.calls[0][1] as CompactionMeta
    expect(meta.summary.endsWith('…[摘要已截断]')).toBe(true)
    expect(meta.summary.length).toBeLessThanOrEqual(boundedLength)
    expect(meta.summary.length).toBeLessThan(hugeSummary.length)
    expect(extractTextFromContent(context.messages[0].content)).toContain('…[摘要已截断]')
  })

  it('二次压缩时把前序摘要显式注入压缩输入并要求增量更新', async () => {
    const context = createContext(createMessages())
    const client = new MockModelClient()
      .addResponse(summaryResponse('第一版摘要'))
      .addResponse(summaryResponse('第二版摘要'))
    const { service } = createService({ context, client })

    await expect(service.runThresholdCompaction(identitySummaryProjection)).resolves.toBe(true)

    // 首次压缩的指令不含前序摘要段
    const firstCall = client.getCalls()[0]
    const firstInstruction = firstCall.messages[firstCall.messages.length - 1]
    expect(extractTextFromContent(firstInstruction.content)).not.toContain('前序摘要')

    // 压缩后再积累足够多的消息，触发第二次压缩
    context.messages.push(...Array.from({ length: 30 }, (_, index): ChatMessage => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `round2-${index}-${'y'.repeat(80)}`
    })))

    await expect(service.runThresholdCompaction(identitySummaryProjection)).resolves.toBe(true)

    const secondCall = client.getCalls()[1]
    const secondInstruction = secondCall.messages[secondCall.messages.length - 1]
    const instructionText = extractTextFromContent(secondInstruction.content)
    expect(instructionText).toContain('前序摘要')
    expect(instructionText).toContain('第一版摘要')
    expect(instructionText).toContain('不要推翻重写')
    expect(extractTextFromContent(context.messages[0].content)).toContain('第二版摘要')
  })
})

describe('压缩摘要前缀回放', () => {
  it('摘要请求消息序列是最近主请求投影视图的逐字节前缀 + 指令尾部', async () => {
    const messages = createProjectedHistoryFixture()
    const context = createContext(messages)
    context.sessionId = 'session-prefix'

    // 桩 artifact 存储：内容寻址 ID 与生产实现一致，并计数写入次数
    let archiveWrites = 0
    context.artifactStore = {
      writeContentAddressed: async (sessionId: string, content: string) => {
        archiveWrites++
        return {
          id: `sha256-${createHash('sha256').update(content, 'utf8').digest('hex')}`,
          sessionId,
          toolName: '_runtime_archived',
          createdAt: 0,
          totalBytes: Buffer.byteLength(content, 'utf8'),
          totalLines: 1,
          truncated: false
        }
      }
    } as unknown as ArtifactStore

    // 活跃轮次的摘要投影：与主请求共用同一归档缓存实例
    const archiveCache = createRequestProjectionArchiveCache()
    const projection = createSummaryProjection({ context, policy: { enabled: true }, archiveCache })

    // 模拟最近一次主请求：投影完整权威消息（大工具结果被归档为占位符，缓存已写入）
    const mainView = await projection.project(messages)
    const bigToolContent = mainView[3].content
    expect(typeof bigToolContent === 'string' && isArchivedPlaceholder(bigToolContent)).toBe(true)
    const warmedWrites = archiveWrites
    expect(warmedWrites).toBe(1)

    const client = new MockModelClient().addResponse(summaryResponse('前缀摘要'))
    const { service } = createService({ context, client })

    await expect(service.runThresholdCompaction(projection)).resolves.toBe(true)

    // 摘要投影复用主请求同一归档缓存实例：压缩期间占位符全部命中缓存，无二次写入
    expect(archiveWrites).toBe(warmedWrites)

    const [summaryCall] = client.getCalls()
    const { oldMessages } = splitForCompaction(messages, MIN_RECENT_MESSAGES)
    const oldCount = oldMessages.length
    expect(oldCount).toBeGreaterThan(0)

    // system + 被压缩区域的投影视图切片与主请求视图逐字节一致：
    // 覆盖归档占位符（tool 结果）与 reasoning 字段（各档案回放策略的输入）不漂移、不剥离
    for (let i = 0; i <= oldCount; i++) {
      expect(JSON.stringify(summaryCall.messages[i])).toBe(JSON.stringify(mainView[i]))
    }
    expect(summaryCall.messages.some(m => m.reasoningContent !== undefined)).toBe(true)

    // 指令仅作为尾部追加：末条旧消息为 user 时含 assistant 桥接，否则仅指令本身
    const expectedTailLength = oldMessages[oldMessages.length - 1]?.role === 'user' ? 2 : 1
    expect(summaryCall.messages).toHaveLength(1 + oldCount + expectedTailLength)
    const tail = summaryCall.messages.slice(1 + oldCount)
    expect(tail.at(-1)?.internal).toBe(true)
    expect(extractTextFromContent(tail.at(-1)!.content)).toContain('结构化摘要')
    if (expectedTailLength === 2) {
      expect(tail[0].role).toBe('assistant')
    }

    // 用途标记用于诊断与门禁识别摘要调用
    expect(summaryCall.options?.purpose).toBe('compaction-summary')
  })

  it('无路由 key 的会话摘要调用不携带，配置后与主对话同槽位路由', async () => {
    const client = new MockModelClient().addResponse(summaryResponse('摘要'))
    const context = createContext(createProjectedHistoryFixture())
    const { service } = createService({ context, client, promptCacheKey: 'routing-key-A' })

    await expect(service.runThresholdCompaction(identitySummaryProjection)).resolves.toBe(true)
    expect(client.getCalls()[0].options?.promptCacheKey).toBe('routing-key-A')
  })
})
