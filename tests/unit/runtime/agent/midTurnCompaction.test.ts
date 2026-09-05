import { describe, expect, it, vi } from 'vitest'
import { CacheDiagnostics } from '../../../../src/runtime/model/cacheDiagnostics'
import type { ChatMessage } from '../../../../src/runtime/model/types'
import { extractTextFromContent } from '../../../../src/runtime/model/types'
import {
  createProductionContextBudgetManager,
  defaultContextBudgetManager,
  resolveProductionBudgetLimits
} from '../../../../src/runtime/agent/ContextBudgetManager'
import { CompactionService } from '../../../../src/runtime/agent/compaction/CompactionService'
import { measureRequestBudget } from '../../../../src/runtime/model/requestBudget'
import {
  createAgentContext,
  type AgentContext
} from '../../../../src/runtime/agent/core/AgentContext'
import { runAgentLoop } from '../../../../src/runtime/agent/core/runAgentLoop'
import { HookManager } from '../../../../src/runtime/agent/core/HookManager'
import type { CompactionMeta } from '../../../../src/runtime/agent/types'
import { createReadState } from '../../../../src/runtime/tools/editTool'
import { MockModelClient } from '../../../../src/test-support/builders/MockModelClient'
import { identitySummaryProjection } from '../../../../src/test-support/builders/identitySummaryProjection'
import type { TurnStreamResult } from '../../../../src/runtime/agent/stream/streamTypes'
import type { ToolBatchExecutionResult } from '../../../../src/runtime/agent/execution/toolBatchExecutor'
import {
  getTailTokenBudget,
  splitForCompactionByTokens
} from '../../../../src/runtime/agent/compaction/compaction'

function createContext(messages: ChatMessage[]): AgentContext {
  return createAgentContext({
    readState: createReadState(),
    messages,
    systemPrompt: typeof messages[0]?.content === 'string' ? messages[0].content : 'system'
  })
}

function createService(options?: {
  context?: AgentContext
  client?: MockModelClient
  contextWindow?: number
  onCompaction?: (context: ChatMessage[], meta: CompactionMeta) => void
  useProductionBudget?: boolean
}): {
  service: CompactionService
  context: AgentContext
  client: MockModelClient
} {
  const context = options?.context ?? createContext([
    { role: 'system', content: 'system prompt' },
    { role: 'user', content: 'hello' }
  ])
  const client = options?.client ?? new MockModelClient()
  const contextWindow = options?.contextWindow ?? 8_000
  const service = new CompactionService({
    context,
    modelClient: client,
    contextBudgetManager: options?.useProductionBudget
      ? createProductionContextBudgetManager({ contextWindow })
      : defaultContextBudgetManager,
    cacheDiagnostics: new CacheDiagnostics(),
    contextWindow,
    onCompaction: options?.onCompaction,
    getIdleCacheProfile: () => ({ idlePolicy: 'anthropic-short-ttl' }),
    idleProjection: identitySummaryProjection
  })
  return { service, context, client }
}

function buildHistoryForMidTurn(opts: { fillerChars: number; pairs: number }): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: 'system', content: 'system prompt' }]
  messages.push({ role: 'user', content: 'x'.repeat(opts.fillerChars) })
  for (let i = 0; i < opts.pairs; i++) {
    const id = `call-${i}`
    messages.push({
      role: 'assistant',
      content: '',
      toolCalls: [{ id, name: 'read', arguments: '{}' }]
    })
    messages.push({
      role: 'tool',
      content: `tool-result-${i}-` + 'y'.repeat(200),
      toolCallId: id
    })
  }
  return messages
}

it.each([20, 20_000])('工具写回后唯一预算 Owner 决定是否继续，结果长度 %i', async size => {
  const context = createContext([{ role: 'system', content: 's' }, { role: 'user', content: 'go' }])
  context.dialect = 'native'
  const { service } = createService({ context, contextWindow: 8000 })
  let streamCalls = 0
  let error = ''
  const streamProcessor = { run: async (): Promise<TurnStreamResult> => {
    streamCalls++
    return streamCalls === 1
      ? { kind: 'assistant', assistantContent: '', toolCalls: [{ id: 't', name: 'read', arguments: '{}' }], finishReason: 'tool_calls', sawUsage: false }
      : { kind: 'assistant', assistantContent: 'done', toolCalls: [], finishReason: 'stop', sawUsage: false }
  } }
  const result = await runAgentLoop({ messageId: 'm', userText: 'go', context,
    config: { maxToolRounds: 5, toolExecution: 'parallel', maxParallelToolCalls: 4, supportsVision: false },
    streamProcessor: streamProcessor as never, hookManager: new HookManager(), emit: () => {}, emitContextBreakdown: () => {},
    signal: () => false, abortSignal: () => undefined,
    executeBatch: async () => ({ aborted: false, outcomes: [{ index: 0, toolCall: { id: 't', name: 'read', arguments: '{}' }, args: {}, resultText: 'x'.repeat(size), failed: false }] }),
    prepareMainRequest: (messages, tools, projection) => service.prepareMainRequest(messages, tools, projection),
    observeMainRequest: (tokens, request, source, revision) => { service.observeMainRequest(tokens, request, source, revision) },
    updateTokenEstimate: () => service.updateTokenEstimate(), sleep: async () => {}, onTerminalError: text => { error = text }
  })
  expect(streamCalls).toBe(size === 20 ? 2 : 1)
  expect(result.ended).toBe(size === 20 ? 'normal' : 'error')
  expect(context.messages.find(m => m.role === 'tool')?.content).toBe('x'.repeat(size))
  if (size > 20) expect(error).toContain('ContextBudgetExceeded')
})

describe('CompactionService mid-turn', () => {
  it('超高水位时压缩，保留 tool 对完整与 tail', async () => {
    const messages = buildHistoryForMidTurn({ fillerChars: 20_000, pairs: 4 })
    const onCompaction = vi.fn()
    const client = new MockModelClient().addHandoffPair({
      events: [
        { type: 'text_delta', delta: 'mid-turn summary' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })
    const { service, context } = createService({
      context: createContext(messages),
      client,
      contextWindow: 8_000,
      onCompaction,
      useProductionBudget: true
    })
    const expectedTail = splitForCompactionByTokens(
      messages,
      getTailTokenBudget(8_000)
    ).recentMessages

    // 锚点接近高水位，再叠加大 delta 触发
    const { highWaterTokens } = resolveProductionBudgetLimits({ contextWindow: 8_000 })
    const request = measureRequestBudget({ messages: messages.slice(0, 3), tools: undefined }, 'unknown', 8000)
    service.observeMainRequest(highWaterTokens - 10, request, { routeId: 'unknown', purpose: 'main', logicalRequestId: 'l', physicalAttemptId: 'p' })

    await expect(service.runMidTurnCompaction(identitySummaryProjection)).resolves.toBe(true)

    expect(onCompaction).toHaveBeenCalledWith(
      context.messages,
      expect.objectContaining({ trigger: 'mid-turn', summary: expect.stringContaining('mid-turn summary') })
    )
    expect(extractTextFromContent(context.messages[0].content)).toContain('mid-turn summary')
    const nonSystem = context.messages.filter(m => m.role !== 'system')
    expect(nonSystem).toEqual(expectedTail)
    for (const assistant of nonSystem.filter(m => m.role === 'assistant' && m.toolCalls)) {
      for (const call of assistant.toolCalls!) {
        expect(nonSystem.some(m => m.role === 'tool' && m.toolCallId === call.id)).toBe(true)
      }
    }
  })

  it('fail-open：摘要失败时不改写 messages', async () => {
    const messages = buildHistoryForMidTurn({ fillerChars: 20_000, pairs: 3 })
    const original = messages.map(m => ({ ...m }))
    const client = new MockModelClient().addResponse({
      events: [{ type: 'error', error: 'summary failed' }]
    })
    const { service, context } = createService({
      context: createContext(messages),
      client,
      contextWindow: 8_000,
      useProductionBudget: true
    })
    const { highWaterTokens } = resolveProductionBudgetLimits({ contextWindow: 8_000 })


    await expect(service.runMidTurnCompaction(identitySummaryProjection)).resolves.toBe(false)
    expect(context.messages).toEqual(original)
    expect(context.compactionLevel).toBe(0)
  })

  it('无可安全边界时 fail-open', async () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 's' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'only', name: 'read', arguments: '{}' }]
      },
      { role: 'tool', content: 'r'.repeat(50_000), toolCallId: 'only' }
    ]
    const { service, context } = createService({
      context: createContext(messages),
      contextWindow: 8_000,
      useProductionBudget: true
    })
    const { highWaterTokens } = resolveProductionBudgetLimits({ contextWindow: 8_000 })


    await expect(service.runMidTurnCompaction(identitySummaryProjection)).resolves.toBe(false)
    expect(context.messages).toHaveLength(3)
  })
})
