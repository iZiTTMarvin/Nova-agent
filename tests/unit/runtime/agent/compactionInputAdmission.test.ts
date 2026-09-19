import { describe, expect, it } from 'vitest'
import { CacheDiagnostics } from '../../../../src/runtime/model/cacheDiagnostics'
import type { ChatMessage, ToolDefinition } from '../../../../src/runtime/model/types'
import type { RequestBudgetMeasurement } from '../../../../src/runtime/model/requestBudget'
import { measureRequestBudget } from '../../../../src/runtime/model/requestBudget'
import { CompactionService } from '../../../../src/runtime/agent/compaction/CompactionService'
import {
  getTailTokenBudget,
  splitForCompactionByTokens
} from '../../../../src/runtime/agent/compaction/compaction'
import { createAgentContext } from '../../../../src/runtime/agent/core/AgentContext'
import { createReadState } from '../../../../src/runtime/tools/editTool'
import { MockModelClient } from '../../../../src/test-support/builders/MockModelClient'
import { identitySummaryProjection } from '../../../../src/test-support/builders/identitySummaryProjection'

const CONTEXT_WINDOW = 8_000
const INPUT_LIMIT = 6_800

function requestUnits(messages: ChatMessage[], tools?: ToolDefinition[]): number {
  return Math.ceil(JSON.stringify({ messages, tools }).length / 3)
}

function measure(messages: ChatMessage[], tools?: ToolDefinition[]): RequestBudgetMeasurement {
  return {
    ...measureRequestBudget({ messages, tools }, 'test-route', CONTEXT_WINDOW),
    budgetUnits: requestUnits(messages, tools)
  }
}

function createBudgetManager() {
  return {
    enforceInline(messages: ChatMessage[]) {
      const estimatedTokens = requestUnits(messages)
      const serializedBytes = Buffer.byteLength(JSON.stringify(messages), 'utf8')
      return estimatedTokens > INPUT_LIMIT
        ? { status: 'requires_compaction' as const, estimatedTokens, serializedBytes }
        : { status: 'within_budget' as const, estimatedTokens, serializedBytes }
    }
  }
}

function createService(messages: ChatMessage[], client: MockModelClient): CompactionService {
  const context = createAgentContext({
    readState: createReadState(),
    messages,
    systemPrompt: 'system prompt'
  })
  return new CompactionService({
    context,
    modelClient: client,
    contextBudgetManager: createBudgetManager(),
    cacheDiagnostics: new CacheDiagnostics(),
    contextWindow: CONTEXT_WINDOW,
    measureRequest: measure,
    getIdleCacheProfile: () => null,
    idleProjection: identitySummaryProjection
  })
}

describe('compaction input admission', () => {
  it('窗口骤缩时向前收缩摘要切点，并把未摘要内容原样留在 tail', async () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: '继续检查这个仓库', origin: { messageId: 'u0', step: 0 } },
      ...Array.from({ length: 10 }, (_, index): ChatMessage => ({
        role: 'assistant',
        content: `segment-${index} ${'alpha '.repeat(500)}`,
        origin: { messageId: `a${index}`, step: index }
      }))
    ]
    const initial = splitForCompactionByTokens(messages, getTailTokenBudget(CONTEXT_WINDOW))
    const initiallyFoldedBoundary = initial.oldMessages.at(-1)
    expect(initiallyFoldedBoundary).toBeDefined()

    const client = new MockModelClient().addHandoffPair({ events: [
      { type: 'text_delta', delta: '继续检查仓库' },
      { type: 'message_end', finishReason: 'stop' }
    ] })
    const service = createService(structuredClone(messages), client)

    await expect(service.runOverflowCompaction('standard', identitySummaryProjection)).resolves.toBe(true)

    const calls = client.getCalls()
    expect(calls).toHaveLength(2)
    expect(calls.every(call => requestUnits(call.messages, call.tools) <= INPUT_LIMIT)).toBe(true)

    const compacted = (service as unknown as { context: { messages: ChatMessage[] } }).context.messages
    expect(requestUnits(compacted)).toBeLessThanOrEqual(INPUT_LIMIT)
    expect(compacted.some(message => message.content === initiallyFoldedBoundary!.content)).toBe(true)
    service.dispose()
  })

  it('没有任何安全非空切点时不删证据，也不向 provider 发必然溢出的摘要请求', async () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'system prompt' },
      { role: 'assistant', content: `oversized ${'beta '.repeat(5_000)}`, origin: { messageId: 'a0', step: 0 } },
      { role: 'user', content: '继续', origin: { messageId: 'u1', step: 1 } }
    ]
    const original = structuredClone(messages)
    const client = new MockModelClient().addHandoffPair({ events: [
      { type: 'text_delta', delta: '不会被调用' },
      { type: 'message_end', finishReason: 'stop' }
    ] })
    const service = createService(messages, client)

    await expect(service.runOverflowCompaction('standard', identitySummaryProjection)).resolves.toBe(false)
    expect(client.getCalls()).toHaveLength(0)
    expect((service as unknown as { context: { messages: ChatMessage[] } }).context.messages).toEqual(original)
    service.dispose()
  })
})
