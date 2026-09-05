import { describe, expect, it, vi } from 'vitest'
import { CacheDiagnostics } from '../../../../src/runtime/model/cacheDiagnostics'
import type { ChatEvent, ChatMessage } from '../../../../src/runtime/model/types'
import { extractTextFromContent } from '../../../../src/runtime/model/types'
import { defaultContextBudgetManager } from '../../../../src/runtime/agent/ContextBudgetManager'
import { CompactionService } from '../../../../src/runtime/agent/compaction/CompactionService'
import {
  createAgentContext,
  type AgentContext
} from '../../../../src/runtime/agent/core/AgentContext'
import type { CompactionMeta } from '../../../../src/runtime/agent/types'
import { createReadState } from '../../../../src/runtime/tools/editTool'
import { MockModelClient } from '../../../../src/test-support/builders/MockModelClient'
import { identitySummaryProjection } from '../../../../src/test-support/builders/identitySummaryProjection'
import { makeCompactionLedger, handoffJson } from '../../../../src/test-support/builders/compactionLedger'
import { OpenAICompatibleModelClient } from '../../../../src/runtime/model/OpenAICompatibleModelClient'
import { getMetricBuffer, registerMetricSink, resetMetricsForTests } from '../../../../src/shared/diagnostics/metrics'

/** 恒等投影：单测里摘要输入与权威消息逐条一致，便于断言服务侧行为 */


function createMessages(count = 30): ChatMessage[] {
  return [
    { role: 'system', content: 'system prompt' },
    ...Array.from({ length: count }, (_, index): ChatMessage => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `message-${index}-${'x'.repeat(80)}`
    }))
  ]
}

function createContext(messages = createMessages()): AgentContext {
  return createAgentContext({
    readState: createReadState(),
    messages,
    systemPrompt: 'system prompt'
  })
}

function createService(options?: {
  context?: AgentContext
  client?: Pick<MockModelClient, 'chat' | 'getCalls'>
  contextWindow?: number
  onCompaction?: (context: ChatMessage[], meta: CompactionMeta) => void
  promptCacheKey?: string
}): {
  service: CompactionService
  context: AgentContext
  client: Pick<MockModelClient, 'chat' | 'getCalls'>
  cacheDiagnostics: CacheDiagnostics
} {
  const context = options?.context ?? createContext()
  const client = options?.client ?? new MockModelClient()
  const cacheDiagnostics = new CacheDiagnostics()
  const service = new CompactionService({
    context,
    modelClient: client,
    contextBudgetManager: defaultContextBudgetManager,
    cacheDiagnostics,
    contextWindow: options?.contextWindow ?? 100,
    onCompaction: options?.onCompaction,
    getIdleCacheProfile: () => ({ idlePolicy: 'anthropic-short-ttl' }),
    idleProjection: identitySummaryProjection,
    ...(options?.promptCacheKey ? { promptCacheKey: options.promptCacheKey } : {})
  })
  return { service, context, client, cacheDiagnostics }
}

describe('CompactionService', () => {
  it('真实客户端的 stub/state 保持并行，usage 与上下文采纳独立关联', async () => {
    const previous = process.env.NOVA_METRICS
    process.env.NOVA_METRICS = '1'
    registerMetricSink(() => {})
    const releases: Array<() => void> = []
    const client = new OpenAICompatibleModelClient({
      baseUrl: 'https://example.test/v1', apiKey: 'fixture', modelId: 'model',
      fetchImpl: async () => new Promise<Response>(resolve => {
        releases.push(() => resolve(new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: handoffJson('summary') }, finish_reason: 'stop' }] })}\n\ndata: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":2}}\n\ndata: [DONE]\n\n`)))
      })
    })
    const { service } = createService({ client: { chat: client.chat.bind(client), getCalls: () => [] } })
    try {
      const pending = service.runThresholdCompaction(identitySummaryProjection)
      await vi.waitFor(() => expect(releases).toHaveLength(2))
      releases.forEach(release => release())
      expect(await pending).toBe(true)
      const reported = getMetricBuffer().filter(e => e.category === 'usage.report')
      const adopted = getMetricBuffer().filter(e => e.category === 'usage.adoption')
      expect(reported.map(e => e.tags?.purpose).sort()).toEqual(['compaction-state', 'compaction-stub'])
      expect(new Set(reported.map(e => e.id)).size).toBe(2)
      expect(reported.map(e => e.tags?.cacheCountCoverage)).toEqual(['unreported', 'unreported'])
      expect(adopted).toHaveLength(2)
      expect(adopted.map(e => e.tags?.physicalAttemptId).sort()).toEqual(reported.map(e => e.tags?.physicalAttemptId).sort())
      expect(adopted.every(e => e.values.adopted === 1)).toBe(true)
      expect(reported.reduce((sum, e) => sum + e.values.promptTokens, 0)).toBe(200)
    } finally {
      service.dispose()
      resetMetricsForTests()
      if (previous === undefined) delete process.env.NOVA_METRICS
      else process.env.NOVA_METRICS = previous
    }
  })
  it('threshold 未命中时不调用摘要模型', async () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'short message' }
    ]
    const context = createContext(messages)
    const { service, client } = createService({ context, contextWindow: 200_000 })

    await expect(service.runThresholdCompaction(identitySummaryProjection)).resolves.toBe(false)

    expect(client.getCalls()).toHaveLength(0)
    expect(context.messages).toBe(messages)
  })

  it('threshold 命中后统一应用摘要、簿记、缓存 epoch 与回调 payload', async () => {
    const original = createMessages()
    original[1].reasoningContent = 'internal reasoning'
    const context = createContext(original)
    context.userTurnsSinceCompaction = 7
    const client = new MockModelClient().addHandoffPair({
      events: [
        { type: 'text_delta', delta: '  compacted summary  ' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })
    const onCompaction = vi.fn()
    const { service, cacheDiagnostics } = createService({
      context,
      client,
      onCompaction,
      promptCacheKey: 'routing-key-1'
    })

    await expect(service.runThresholdCompaction(identitySummaryProjection)).resolves.toBe(true)

    expect(extractTextFromContent(context.messages[0].content)).toContain('compacted summary')
    const tail = context.messages.slice(1)
    expect(tail.length).toBeGreaterThan(0)
    expect(original.slice(-tail.length)).toEqual(tail)
    expect(context.compactionLevel).toBe(1)
    expect(context.userTurnsSinceCompaction).toBe(0)
    expect(context.lastEstimatedTokens).toBeGreaterThan(0)
    expect(cacheDiagnostics.getEpochReason()).toBe('compaction')
    expect(onCompaction).toHaveBeenCalledTimes(1)
    const meta = onCompaction.mock.calls[0][1]
    expect(meta).toMatchObject({
      summary: expect.stringContaining('compacted summary'),
      compactionLevel: 1,
      trigger: 'threshold'
    })
    expect(meta.ledger.entries).toHaveLength(1)
    expect(meta.ledger.state?.handoff.goal).toBe('compacted summary')
    expect(context.compactionState).toBe(meta.ledger)

    const summaryCalls = client.getCalls()
    expect(summaryCalls).toHaveLength(2)
    for (const [index, summaryCall] of summaryCalls.entries()) {
      expect(summaryCall.options).toMatchObject({
        includeInternalMessages: true,
        purpose: index === 0 ? 'compaction-stub' : 'compaction-state'
      })
      expect(summaryCall.options?.promptCacheKey).toBe('routing-key-1')
      expect(summaryCall.messages.some(message => message.reasoningContent !== undefined)).toBe(true)
    }
  })

  it('standard overflow 成功时保留最近消息与 pulled-back 消息的原始顺序', async () => {
    const original = createMessages(32)
    const context = createContext(original)
    const client = new MockModelClient().addHandoffPair({
      events: [
        { type: 'text_delta', delta: 'overflow summary' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })
    const { service } = createService({ context, client })

    await expect(service.runOverflowCompaction('standard', identitySummaryProjection)).resolves.toBe(true)

    const tail = context.messages.slice(1)
    expect(tail.length).toBeGreaterThan(0)
    expect(original.slice(-tail.length)).toEqual(tail)
    expect(extractTextFromContent(context.messages[0].content)).toContain('overflow summary')
    expect(service.isCompressingForOverflow()).toBe(false)

    // overflow 与 threshold 共用同一摘要调用点：无路由 key 的会话同样不携带
    expect(client.getCalls()).toHaveLength(2)
    for (const [index, summaryCall] of client.getCalls().entries()) {
      expect(summaryCall.options?.promptCacheKey).toBeUndefined()
      expect(summaryCall.options?.purpose).toBe(index === 0 ? 'compaction-stub' : 'compaction-state')
    }
  })

  it('overflow 组合层不会拆散 recent 与 pulled-back 边界上的工具调用组', async () => {
    const toolAssistant: ChatMessage = {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'call-1', name: 'read', arguments: '{"path":"a.ts"}' }]
    }
    const toolResult: ChatMessage = {
      role: 'tool',
      content: 'file content',
      toolCallId: 'call-1'
    }
    const original: ChatMessage[] = [
      { role: 'system', content: 'system prompt' },
      ...Array.from({ length: 9 }, (_, index): ChatMessage => ({
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `prefix-${index}-` + 'x'.repeat(800)
      })),
      toolAssistant,
      toolResult,
      ...Array.from({ length: 20 }, (_, index): ChatMessage => ({
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `tail-${index}`
      }))
    ]
    const context = createContext(original)
    const client = new MockModelClient().addHandoffPair({
      events: [
        { type: 'text_delta', delta: 'tool-safe summary' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })
    const { service } = createService({ context, client, contextWindow: 2_000 })

    await expect(service.runOverflowCompaction('standard', identitySummaryProjection)).resolves.toBe(true)

    const assistantIndex = context.messages.findIndex(message =>
      message.role === 'assistant' && message.toolCalls?.[0]?.id === 'call-1'
    )
    const resultIndex = context.messages.findIndex(message =>
      message.role === 'tool' && message.toolCallId === 'call-1'
    )
    expect(assistantIndex).toBeGreaterThan(0)
    expect(resultIndex).toBe(assistantIndex + 1)
    expect(context.messages.at(-1)).toEqual(original.at(-1))
  })

  it('standard 失败后可由 aggressive 成功，失败尝试不改写共享 context', async () => {
    const original = createMessages(70)
    const originalSnapshot = structuredClone(original)
    const context = createContext(original)
    const overflowFail = { events: [{ type: 'context_overflow' as const, rawError: 'still too large' }] }
    const client = new MockModelClient()
      .addHandoffPair(overflowFail)
      .addHandoffPair({
        events: [
          { type: 'text_delta', delta: 'aggressive summary' },
          { type: 'message_end', finishReason: 'stop' }
        ]
      })
    const { service } = createService({ context, client })

    await expect(service.runOverflowCompaction('standard', identitySummaryProjection)).resolves.toBe(false)
    expect(context.messages).toEqual(originalSnapshot)

    await expect(service.runOverflowCompaction('aggressive', identitySummaryProjection)).resolves.toBe(true)
    expect(extractTextFromContent(context.messages[0].content)).toContain('aggressive summary')
    expect(context.messages.at(-1)).toEqual(originalSnapshot.at(-1))
  })

  it('standard 与 aggressive 都失败时保持上下文和簿记不变', async () => {
    const original = createMessages(70)
    const snapshot = structuredClone(original)
    const context = createContext(original)
    context.compactionLevel = 2
    context.userTurnsSinceCompaction = 6
    context.lastEstimatedTokens = 1234
    const client = new MockModelClient()
      .addHandoffPair({ events: [{ type: 'error', error: 'standard failed' }] })
      .addHandoffPair({ events: [{ type: 'context_overflow', rawError: 'aggressive failed' }] })
    const onCompaction = vi.fn()
    const { service, cacheDiagnostics } = createService({ context, client, onCompaction })

    await expect(service.runOverflowCompaction('standard', identitySummaryProjection)).resolves.toBe(false)
    await expect(service.runOverflowCompaction('aggressive', identitySummaryProjection)).resolves.toBe(false)

    expect(context.messages).toEqual(snapshot)
    expect(context.compactionLevel).toBe(2)
    expect(context.userTurnsSinceCompaction).toBe(6)
    expect(context.lastEstimatedTokens).toBe(1234)
    expect(cacheDiagnostics.getEpochReason()).toBe('session_init')
    expect(onCompaction).not.toHaveBeenCalled()
  })

  it('abort 在写回前到达时不替换 context 或触发持久化回调', async () => {
    const abortController = new AbortController()
    const original = createMessages()
    const context = createContext(original)
    const onCompaction = vi.fn()
    const client = {
      getCalls: () => [],
      async *chat(): AsyncIterable<ChatEvent> {
        yield { type: 'text_delta', delta: 'must not be applied' }
        abortController.abort()
        yield { type: 'message_end', finishReason: 'stop' }
      }
    }
    const { service } = createService({ context, client, onCompaction })

    await expect(service.runThresholdCompaction(identitySummaryProjection, abortController.signal)).resolves.toBe(false)

    expect(context.messages).toBe(original)
    expect(context.compactionLevel).toBe(0)
    expect(onCompaction).not.toHaveBeenCalled()
  })

  it('重建上下文的投影等待期间取消时不写回任何压缩状态', async () => {
    const original = createMessages()
    const snapshot = structuredClone(original)
    const context = createContext(original)
    const abortController = new AbortController()
    const onCompaction = vi.fn()
    let projectionCalls = 0
    let releaseSecondProjection: ((messages: ChatMessage[]) => void) | undefined
    const projection = {
      project: async (messages: ChatMessage[]): Promise<ChatMessage[]> => {
        projectionCalls++
        if (projectionCalls === 2) {
          return new Promise(resolve => {
            releaseSecondProjection = resolve
          })
        }
        return messages
      }
    }
    const client = new MockModelClient().addHandoffPair({
      events: [
        { type: 'text_delta', delta: 'compacted summary' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })
    const { service } = createService({ context, client, onCompaction })
    const compaction = service.runThresholdCompaction(projection, abortController.signal)

    await vi.waitFor(() => expect(projectionCalls).toBe(2))
    abortController.abort()
    releaseSecondProjection?.(snapshot)

    await expect(compaction).resolves.toBe(false)
    expect(context.messages).toBe(original)
    expect(context.messages).toEqual(snapshot)
    expect(context.compactionLevel).toBe(0)
    expect(onCompaction).not.toHaveBeenCalled()
  })

  it('一轮内两次压缩 system 只有一份 state，没有第二段摘要标记', async () => {
    const original = createMessages()
    const context = createContext(original)
    const client = new MockModelClient()
      .addHandoffPair({
        events: [
          { type: 'text_delta', delta: '第一版摘要' },
          { type: 'message_end', finishReason: 'stop' }
        ]
      })
      .addHandoffPair({
        events: [
          { type: 'text_delta', delta: '第二版摘要' },
          { type: 'message_end', finishReason: 'stop' }
        ]
      })
    const { service } = createService({ context, client, contextWindow: 80 })

    await expect(service.runThresholdCompaction(identitySummaryProjection)).resolves.toBe(true)
    const afterFirst = extractTextFromContent(context.messages[0].content)
    expect(afterFirst).toContain('第一版摘要')
    expect(afterFirst).not.toContain('[对话历史摘要]')

    for (let i = 0; i < 12; i++) {
      context.messages.push({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `extra-${i}-${'z'.repeat(80)}`
      })
    }
    context.userTurnsSinceCompaction = 7
    await expect(service.runThresholdCompaction(identitySummaryProjection)).resolves.toBe(true)
    const systemText = extractTextFromContent(context.messages[0].content)
    expect(systemText).toContain('第二版摘要')
    expect(systemText).not.toContain('第一版摘要')
    expect(systemText.split('第二版摘要')).toHaveLength(2)
    expect(systemText).not.toContain('[对话历史摘要]')
    expect(context.compactionState?.state?.handoff?.goal).toBe('第二版摘要')
    expect(context.compactionState?.entries.length).toBe(2)
  })

  it('stub 失败且 state 成功时降级为指针 stub 并提交账本', async () => {
    const original = createMessages()
    const context = createContext(original)
    const client = new MockModelClient()
      .addResponse({ events: [{ type: 'error', error: 'stub failed' }] })
      .addResponse({
        events: [
          { type: 'text_delta', delta: handoffJson('state still ok') },
          { type: 'message_end', finishReason: 'stop' }
        ]
      })
    const onCompaction = vi.fn()
    const { service } = createService({ context, client, onCompaction })

    await expect(service.runThresholdCompaction(identitySummaryProjection)).resolves.toBe(true)

    expect(context.compactionState?.state?.handoff?.goal).toBe('state still ok')
    expect(context.compactionState?.entries).toHaveLength(1)
    expect(context.compactionState?.entries[0]?.stub).toContain('history_read')
    expect(context.compactionState?.entries[0]?.stub).not.toContain('stub failed')
    expect(onCompaction).toHaveBeenCalledTimes(1)
  })

  it('state 失败时整轮放弃，不写账本', async () => {
    const original = createMessages()
    const context = createContext(original)
    const client = new MockModelClient()
      .addResponse({
        events: [
          { type: 'text_delta', delta: 'stub ok' },
          { type: 'message_end', finishReason: 'stop' }
        ]
      })
      .addResponse({ events: [{ type: 'error', error: 'state failed' }] })
    const onCompaction = vi.fn()
    const { service } = createService({ context, client, onCompaction })

    await expect(service.runThresholdCompaction(identitySummaryProjection)).resolves.toBe(false)

    expect(context.messages).toBe(original)
    expect(context.compactionState).toBeNull()
    expect(context.compactionLevel).toBe(0)
    expect(onCompaction).not.toHaveBeenCalled()
  })

  it('restore 与 user turn 记账也由 service 更新同一 AgentContext', () => {
    const context = createContext([
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'old message' }
    ])
    const { service, cacheDiagnostics } = createService({ context })
    const recent: ChatMessage[] = [
      { role: 'user', content: 'recent user' },
      { role: 'assistant', content: 'recent assistant' }
    ]
    const ledger = makeCompactionLedger({ summary: 'restored summary', entryCount: 3 })

    service.restoreCompactedContext(ledger, recent)
    expect(context.messages.slice(1)).toEqual(recent)
    expect(context.compactionLevel).toBe(3)
    expect(context.compactionState).toBe(ledger)
    expect(extractTextFromContent(context.messages[0].content)).toContain('restored summary')
    expect(context.userTurnsSinceCompaction).toBe(0)
    expect(cacheDiagnostics.getEpochReason()).toBe('compaction')

    const beforeTokens = context.lastEstimatedTokens
    context.messages.push({ role: 'user', content: 'next turn' })
    service.recordUserTurn()
    expect(context.userTurnsSinceCompaction).toBe(1)
    expect(context.lastEstimatedTokens).toBeGreaterThan(beforeTokens)
  })

  it('当前任务 user 被折叠时写入 taskVerbatim，仍在尾部则为 null', async () => {
    const folded = [
      { role: 'system' as const, content: 'system prompt' },
      ...Array.from({ length: 20 }, (_, index): ChatMessage => ({
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `fat-${index}-${'x'.repeat(80)}`,
        origin: { messageId: `m${index}`, step: 0 }
      })),
      {
        role: 'user' as const,
        content: 'FOLDED_TASK',
        origin: { messageId: 'u-fold', step: 0 }
      },
      { role: 'assistant' as const, content: 'ack-' + 'y'.repeat(80) }
    ]
    const foldedCtx = createContext(folded)
    const foldedClient = new MockModelClient().addHandoffPair({
      events: [{ type: 'text_delta', delta: 's' }, { type: 'message_end', finishReason: 'stop' }]
    })
    const { service: foldedService } = createService({ context: foldedCtx, client: foldedClient })
    await expect(foldedService.runThresholdCompaction(identitySummaryProjection)).resolves.toBe(true)
    expect(foldedCtx.compactionState?.state?.taskVerbatim?.text).toBe('FOLDED_TASK')

    const tailed = [
      { role: 'system' as const, content: 'system prompt' },
      ...Array.from({ length: 20 }, (_, index): ChatMessage => ({
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `fat-${index}-${'x'.repeat(80)}`,
        origin: { messageId: `n${index}`, step: 0 }
      })),
      {
        role: 'user' as const,
        content: 'KEEP_IN_TAIL',
        origin: { messageId: 'u-tail', step: 0 }
      }
    ]
    const tailedCtx = createContext(tailed)
    const tailedClient = new MockModelClient().addHandoffPair({
      events: [{ type: 'text_delta', delta: 's' }, { type: 'message_end', finishReason: 'stop' }]
    })
    const { service: tailedService } = createService({ context: tailedCtx, client: tailedClient })
    await expect(tailedService.runThresholdCompaction(identitySummaryProjection)).resolves.toBe(true)
    expect(tailedCtx.compactionState?.state?.taskVerbatim).toBeNull()
    expect(extractTextFromContent(tailedCtx.messages[tailedCtx.messages.length - 1]!.content)).toBe('KEEP_IN_TAIL')
  })

  it('同一轮连续压缩保留首次冻结的任务原文', async () => {
    const context = createContext([
      { role: 'system', content: 'system prompt' },
      ...Array.from({ length: 20 }, (_, index): ChatMessage => ({
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `history-${index}-${'h'.repeat(160)}`,
        origin: { messageId: `history-${index}`, step: 0 }
      })),
      {
        role: 'user',
        content: 'FROZEN_TASK',
        origin: { messageId: 'u-task', step: 0 }
      },
      {
        role: 'assistant',
        content: 'a'.repeat(400),
        origin: { messageId: 'a-first', step: 0 }
      }
    ])
    const client = new MockModelClient()
      .addHandoffPair({
        events: [
          { type: 'text_delta', delta: 'first-state' },
          { type: 'message_end', finishReason: 'stop' }
        ]
      })
      .addHandoffPair({
        events: [
          { type: 'text_delta', delta: 'second-state' },
          { type: 'message_end', finishReason: 'stop' }
        ]
      })
    const { service } = createService({ context, client, contextWindow: 100 })

    await expect(service.runThresholdCompaction(identitySummaryProjection)).resolves.toBe(true)
    expect(context.compactionState?.state?.taskVerbatim?.text).toBe('FROZEN_TASK')

    for (let index = 0; index < 8; index++) {
      context.messages.push({
        role: 'assistant',
        content: `continued-${index}-${'b'.repeat(160)}`,
        origin: { messageId: `a-${index}`, step: 0 }
      })
    }
    await expect(service.runThresholdCompaction(identitySummaryProjection)).resolves.toBe(true)
    expect(context.compactionState?.state?.taskVerbatim?.text).toBe('FROZEN_TASK')
  })

  it('提交后交接包只读：追加消息与 touchedFiles 回调变化都不改已提交渲染', async () => {
    const original: ChatMessage[] = [
      { role: 'system', content: 'system prompt' },
      ...Array.from({ length: 30 }, (_, index): ChatMessage => ({
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `message-${index}-${'x'.repeat(800)}`,
        origin: { messageId: `m${index}`, step: 0 }
      }))
    ]
    original[1] = { ...original[1], origin: { messageId: 'u-task', step: 0 } }
    const context = createContext(original)
    const client = new MockModelClient().addHandoffPair({
      events: [
        { type: 'text_delta', delta: 'frozen-state' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })
    let files = ['src/a.ts']
    const serviceWithPorts = new CompactionService({
      context,
      modelClient: client,
      contextBudgetManager: defaultContextBudgetManager,
      cacheDiagnostics: new CacheDiagnostics(),
      contextWindow: 4_000,
      collectTouchedFiles: () => ({ paths: files, omittedCount: 0 }),
      getRealityAnchors: () => ({ workspacePath: '/ws', activePlanPath: '/ws/plan.md' }),
      getIdleCacheProfile: () => ({ idlePolicy: 'anthropic-short-ttl' }),
      idleProjection: identitySummaryProjection
    })

    await expect(serviceWithPorts.runThresholdCompaction(identitySummaryProjection)).resolves.toBe(true)
    const first = extractTextFromContent(context.messages[0].content)
    expect(context.compactionState?.entries[0]?.touchedFiles).toEqual({
      paths: ['src/a.ts'],
      omittedCount: 0
    })
    expect(first).toContain('src/a.ts')
    expect(first).toContain('/ws')
    files = ['src/new.ts']
    context.messages.push({ role: 'user', content: 'later' })
    const second = extractTextFromContent(context.messages[0].content)
    expect(second).toBe(first)
    expect(context.compactionState?.entries[0]?.touchedFiles).toEqual({
      paths: ['src/a.ts'],
      omittedCount: 0
    })
    expect(second).not.toContain('src/new.ts')
    expect(second).not.toContain('later')
  })
})
