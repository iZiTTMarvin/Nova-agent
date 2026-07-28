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
  promptCacheKey?: string
  onCompaction?: (context: ChatMessage[], meta: CompactionMeta) => void
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
    promptCacheKey: options?.promptCacheKey,
    onCompaction: options?.onCompaction
  })
  return { service, context, client, cacheDiagnostics }
}

describe('CompactionService', () => {
  it('threshold 未命中时不调用摘要模型', async () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'short message' }
    ]
    const context = createContext(messages)
    const { service, client } = createService({ context, contextWindow: 200_000 })

    await expect(service.runThresholdCompaction()).resolves.toBe(false)

    expect(client.getCalls()).toHaveLength(0)
    expect(context.messages).toBe(messages)
  })

  it('threshold 命中后统一应用摘要、簿记、缓存 epoch 与回调 payload', async () => {
    const original = createMessages()
    original[1].reasoningContent = 'internal reasoning'
    const context = createContext(original)
    context.userTurnsSinceCompaction = 7
    const client = new MockModelClient().addResponse({
      events: [
        { type: 'text_delta', delta: '  compacted summary  ' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })
    const onCompaction = vi.fn()
    const { service, cacheDiagnostics } = createService({
      context,
      client,
      promptCacheKey: 'session-cache-key',
      onCompaction
    })

    await expect(service.runThresholdCompaction()).resolves.toBe(true)

    expect(extractTextFromContent(context.messages[0].content)).toContain('compacted summary')
    expect(context.messages.slice(1)).toEqual(original.slice(-20))
    expect(context.compactionLevel).toBe(1)
    expect(context.userTurnsSinceCompaction).toBe(0)
    expect(context.lastEstimatedTokens).toBeGreaterThan(0)
    expect(cacheDiagnostics.getEpochReason()).toBe('compaction')
    expect(onCompaction).toHaveBeenCalledWith(context.messages, {
      summary: 'compacted summary',
      compactionLevel: 1,
      trigger: 'threshold'
    })

    const [summaryCall] = client.getCalls()
    expect(summaryCall.options).toMatchObject({
      includeInternalMessages: true,
      expectedCacheMiss: true,
      promptCacheKey: 'session-cache-key'
    })
    expect(summaryCall.messages.some(message => message.reasoningContent !== undefined)).toBe(false)
  })

  it('standard overflow 成功时保留最近消息与 pulled-back 消息的原始顺序', async () => {
    const original = createMessages(32)
    const context = createContext(original)
    const client = new MockModelClient().addResponse({
      events: [
        { type: 'text_delta', delta: 'overflow summary' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })
    const { service } = createService({ context, client })

    await expect(service.runOverflowCompaction('standard')).resolves.toBe(true)

    expect(context.messages.slice(1)).toEqual(original.slice(-21))
    expect(extractTextFromContent(context.messages[0].content)).toContain('overflow summary')
    expect(service.isCompressingForOverflow()).toBe(false)
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
        content: `prefix-${index}`
      })),
      toolAssistant,
      toolResult,
      ...Array.from({ length: 20 }, (_, index): ChatMessage => ({
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `tail-${index}`
      }))
    ]
    const context = createContext(original)
    const client = new MockModelClient().addResponse({
      events: [
        { type: 'text_delta', delta: 'tool-safe summary' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })
    const { service } = createService({ context, client })

    await expect(service.runOverflowCompaction('standard')).resolves.toBe(true)

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
    const client = new MockModelClient()
      .addResponse({ events: [{ type: 'context_overflow', rawError: 'still too large' }] })
      .addResponse({
        events: [
          { type: 'text_delta', delta: 'aggressive summary' },
          { type: 'message_end', finishReason: 'stop' }
        ]
      })
    const { service } = createService({ context, client })

    await expect(service.runOverflowCompaction('standard')).resolves.toBe(false)
    expect(context.messages).toEqual(originalSnapshot)

    await expect(service.runOverflowCompaction('aggressive')).resolves.toBe(true)
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
      .addResponse({ events: [{ type: 'error', error: 'standard failed' }] })
      .addResponse({ events: [{ type: 'context_overflow', rawError: 'aggressive failed' }] })
    const onCompaction = vi.fn()
    const { service, cacheDiagnostics } = createService({ context, client, onCompaction })

    await expect(service.runOverflowCompaction('standard')).resolves.toBe(false)
    await expect(service.runOverflowCompaction('aggressive')).resolves.toBe(false)

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

    await expect(service.runThresholdCompaction(abortController.signal)).resolves.toBe(false)

    expect(context.messages).toBe(original)
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

    service.restoreCompactedContext('restored summary', recent, 3)
    expect(context.messages.slice(1)).toEqual(recent)
    expect(context.compactionLevel).toBe(3)
    expect(context.userTurnsSinceCompaction).toBe(0)
    expect(cacheDiagnostics.getEpochReason()).toBe('compaction')

    const beforeTokens = context.lastEstimatedTokens
    context.messages.push({ role: 'user', content: 'next turn' })
    service.recordUserTurn()
    expect(context.userTurnsSinceCompaction).toBe(1)
    expect(context.lastEstimatedTokens).toBeGreaterThan(beforeTokens)
  })
})
