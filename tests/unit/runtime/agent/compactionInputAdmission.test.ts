import { describe, expect, it } from 'vitest'
import { CacheDiagnostics } from '../../../../src/runtime/model/cacheDiagnostics'
import type { ChatEvent, ChatMessage, ToolDefinition } from '../../../../src/runtime/model/types'
import type { ChatOptions, ModelClient } from '../../../../src/runtime/model/ModelClient'
import type { RequestBudgetMeasurement } from '../../../../src/runtime/model/requestBudget'
import { measureRequestBudget } from '../../../../src/runtime/model/requestBudget'
import { ModelClientPool } from '../../../../src/runtime/model/ModelClientPool'
import {
  ContextBudgetManager,
  resolveProductionBudgetLimits
} from '../../../../src/runtime/agent/ContextBudgetManager'
import { CompactionService } from '../../../../src/runtime/agent/compaction/CompactionService'
import {
  getTailTokenBudget,
  splitForCompactionByTokens
} from '../../../../src/runtime/agent/compaction/compaction'
import { createAgentContext, type AgentContext } from '../../../../src/runtime/agent/core/AgentContext'
import { createReadState } from '../../../../src/runtime/tools/editTool'
import { identitySummaryProjection } from '../../../../src/test-support/builders/identitySummaryProjection'

const PRIMARY_WINDOW = 32_000
const FALLBACK_WINDOW = 8_000

function requestUnits(messages: ChatMessage[], tools?: ToolDefinition[], options?: ChatOptions): number {
  const selected = options?.includeInternalMessages ? messages : messages.filter(message => !message.internal)
  return Math.ceil(JSON.stringify({
    messages: selected,
    tools,
    promptCacheKey: options?.promptCacheKey,
    reasoningEffort: options?.reasoningEffort
  }).length / 3)
}

class BudgetEnforcingClient implements ModelClient {
  readonly calls: Array<{ messages: ChatMessage[]; tools?: ToolDefinition[]; options?: ChatOptions }> = []
  overflowAttempts = 0

  constructor(
    private readonly contextWindow: number,
    private readonly stateText = '继续检查仓库'
  ) {}

  measureRequest(messages: ChatMessage[], tools?: ToolDefinition[], options?: ChatOptions): RequestBudgetMeasurement {
    return {
      ...measureRequestBudget({ messages, tools }, `route-${this.contextWindow}`, this.contextWindow),
      budgetUnits: requestUnits(messages, tools, options)
    }
  }

  async *chat(messages: ChatMessage[], tools?: ToolDefinition[], options?: ChatOptions): AsyncIterable<ChatEvent> {
    this.calls.push({ messages: structuredClone(messages), tools, options })
    const { highWaterTokens } = resolveProductionBudgetLimits({ contextWindow: this.contextWindow })
    if (requestUnits(messages, tools, options) > highWaterTokens) {
      this.overflowAttempts++
      yield { type: 'context_overflow', rawError: 'fixture input exceeds active provider window' }
      return
    }
    if (options?.purpose === 'compaction-state') {
      const instruction = messages.at(-1)?.content
      const facts = typeof instruction === 'string'
        ? JSON.parse(instruction.slice(instruction.lastIndexOf('\n') + 1))
        : []
      yield {
        type: 'text_delta',
        delta: this.stateText.startsWith('{')
          ? this.stateText
          : JSON.stringify({
              schemaVersion: 1,
              goal: this.stateText,
              nextActions: '继续任务',
              keyContext: '(none)',
              progress: '(none)',
              decisions: '(none)',
              facts
            })
      }
    } else {
      yield { type: 'text_delta', delta: '已检查历史' }
    }
    yield { type: 'message_end', finishReason: 'stop' }
  }

  updateConfig(): void {}
}

function createPool(): {
  pool: ModelClientPool
  primary: BudgetEnforcingClient
  fallback: BudgetEnforcingClient
} {
  const primary = new BudgetEnforcingClient(PRIMARY_WINDOW)
  const fallback = new BudgetEnforcingClient(FALLBACK_WINDOW)
  const pool = new ModelClientPool({
    primary,
    primaryConfig: { baseUrl: 'https://primary.test/v1', apiKey: '', modelId: 'primary', contextWindow: PRIMARY_WINDOW },
    fallbacks: [{
      client: fallback,
      config: { baseUrl: 'https://fallback.test/v1', apiKey: '', modelId: 'fallback', contextWindow: FALLBACK_WINDOW }
    }]
  })
  pool.switchToFallback(1)
  return { pool, primary, fallback }
}

function createService(
  messages: ChatMessage[],
  modelClient: ModelClient,
  measureRequest: NonNullable<ConstructorParameters<typeof CompactionService>[0]['measureRequest']>,
  contextWindow = PRIMARY_WINDOW
): { service: CompactionService; context: AgentContext } {
  const context = createAgentContext({
    readState: createReadState(),
    messages,
    systemPrompt: 'system prompt'
  })
  const { highWaterTokens } = resolveProductionBudgetLimits({ contextWindow: FALLBACK_WINDOW })
  const service = new CompactionService({
    context,
    modelClient,
    contextBudgetManager: new ContextBudgetManager({ maxEstimatedTokens: highWaterTokens }),
    cacheDiagnostics: new CacheDiagnostics(),
    contextWindow,
    measureRequest,
    getIdleCacheProfile: () => null,
    idleProjection: identitySummaryProjection
  })
  return { service, context }
}

describe('compaction input admission', () => {
  it('fallback 切到小窗口时用 active provider 预算恢复旧路径会溢出的摘要请求', async () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: '继续检查这个仓库', origin: { messageId: 'u0', step: 0 } },
      ...Array.from({ length: 10 }, (_, index): ChatMessage => ({
        role: 'assistant',
        content: `segment-${index} ${'alpha '.repeat(500)}`,
        origin: { messageId: `a${index}`, step: index }
      }))
    ]
    const initial = splitForCompactionByTokens(messages, getTailTokenBudget(FALLBACK_WINDOW))
    const initiallyFoldedBoundary = initial.oldMessages.at(-1)
    expect(initiallyFoldedBoundary).toBeDefined()

    const { pool, primary, fallback } = createPool()
    expect(pool.measureRequest([]).contextWindow).toBe(FALLBACK_WINDOW)
    const { service, context } = createService(
      structuredClone(messages),
      pool,
      pool.measureRequest.bind(pool)
    )

    await expect(service.runOverflowCompaction('standard', identitySummaryProjection)).resolves.toBe(true)

    expect(primary.calls).toHaveLength(0)
    expect(fallback.overflowAttempts).toBe(0)
    expect(fallback.calls).toHaveLength(2)
    expect(fallback.calls.every(call => requestUnits(call.messages, call.tools, call.options) <=
      resolveProductionBudgetLimits({ contextWindow: FALLBACK_WINDOW }).highWaterTokens)).toBe(true)
    expect(context.messages.some(message => message.content === initiallyFoldedBoundary!.content)).toBe(true)
    service.dispose()
  })

  it('初始摘要请求在 active provider 预算内时保持原切点和逐消息前缀', async () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'system prompt' },
      ...Array.from({ length: 12 }, (_, index): ChatMessage => ({
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `message-${index}-${'safe '.repeat(120)}`,
        origin: { messageId: `m${index}`, step: 0 }
      }))
    ]
    const { pool, fallback } = createPool()
    const { service } = createService(messages, pool, pool.measureRequest.bind(pool))
    const expected = splitForCompactionByTokens(messages, getTailTokenBudget(FALLBACK_WINDOW)).oldMessages

    await expect(service.runOverflowCompaction('standard', identitySummaryProjection)).resolves.toBe(true)

    expect(fallback.calls).toHaveLength(2)
    for (const call of fallback.calls) {
      expect(call.messages.slice(0, 1 + expected.length)).toEqual([messages[0], ...expected])
    }
    service.dispose()
  })

  it('没有任何安全非空切点时不删证据，也不向 provider 发必然溢出的摘要请求', async () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'system prompt' },
      { role: 'assistant', content: `oversized ${'beta '.repeat(5_000)}`, origin: { messageId: 'a0', step: 0 } },
      { role: 'user', content: '继续', origin: { messageId: 'u1', step: 1 } }
    ]
    const original = structuredClone(messages)
    const { pool, fallback } = createPool()
    const { service, context } = createService(messages, pool, pool.measureRequest.bind(pool))

    await expect(service.runOverflowCompaction('standard', identitySummaryProjection)).resolves.toBe(false)
    expect(fallback.calls).toHaveLength(0)
    expect(context.messages).toEqual(original)
    service.dispose()
  })

  it('收紧请求新增候选后超预算时在发送前拒绝', async () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'system prompt' },
      ...Array.from({ length: 12 }, (_, index): ChatMessage => ({
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `message-${index}-${'safe '.repeat(120)}`,
        origin: { messageId: `m${index}`, step: 0 }
      }))
    ]
    const client = new BudgetEnforcingClient(FALLBACK_WINDOW, `{${'x'.repeat(20_000)}`)
    const { service, context } = createService(
      messages,
      client,
      client.measureRequest.bind(client),
      FALLBACK_WINDOW
    )

    await expect(service.runOverflowCompaction('standard', identitySummaryProjection)).resolves.toBe(false)
    expect(client.calls).toHaveLength(2)
    expect(client.overflowAttempts).toBe(0)
    expect(context.compactionState).toBeNull()
    service.dispose()
  })
})
