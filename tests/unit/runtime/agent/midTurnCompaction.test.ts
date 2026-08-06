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
import { measureRequestPayloadChars } from '../../../../src/runtime/agent/compaction/estimateNextRequestTokens'
import {
  createAgentContext,
  type AgentContext
} from '../../../../src/runtime/agent/core/AgentContext'
import { runAgentLoop } from '../../../../src/runtime/agent/core/runAgentLoop'
import { HookManager } from '../../../../src/runtime/agent/core/HookManager'
import type { CompactionMeta } from '../../../../src/runtime/agent/types'
import { createReadState } from '../../../../src/runtime/tools/editTool'
import { MockModelClient } from '../../../../src/test-support/builders/MockModelClient'
import type { TurnStreamResult } from '../../../../src/runtime/agent/stream/streamTypes'
import type { ToolBatchExecutionResult } from '../../../../src/runtime/agent/execution/toolBatchExecutor'

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
    getIdleCacheProfile: () => ({ idlePolicy: 'anthropic-short-ttl' })
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

describe('CompactionService mid-turn', () => {
  it('超高水位时压缩，保留 tool 对完整与 tail', async () => {
    const messages = buildHistoryForMidTurn({ fillerChars: 20_000, pairs: 4 })
    const onCompaction = vi.fn()
    const client = new MockModelClient().addResponse({
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

    // 锚点接近高水位，再叠加大 delta 触发
    const { highWaterTokens } = resolveProductionBudgetLimits({ contextWindow: 8_000 })
    const priorPayload = measureRequestPayloadChars(messages.slice(0, 3))
    service.recordRequestAnchor(highWaterTokens - 10, priorPayload)

    await expect(service.runMidTurnCompaction()).resolves.toBe(true)

    expect(onCompaction).toHaveBeenCalledWith(
      context.messages,
      expect.objectContaining({ trigger: 'mid-turn', summary: 'mid-turn summary' })
    )
    expect(extractTextFromContent(context.messages[0].content)).toContain('mid-turn summary')
    // tail 至少保留一条；工具对不得被切断
    const nonSystem = context.messages.filter(m => m.role !== 'system')
    expect(nonSystem.length).toBeGreaterThanOrEqual(1)
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
    service.recordRequestAnchor(highWaterTokens + 100, 100)

    await expect(service.runMidTurnCompaction()).resolves.toBe(false)
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
    service.recordRequestAnchor(highWaterTokens + 50, 10)

    await expect(service.runMidTurnCompaction()).resolves.toBe(false)
    expect(context.messages).toHaveLength(3)
  })
})

describe('runAgentLoop mid-turn integration', () => {
  it('工具写回后调用 mid-turn；压缩失败时请求照常发出', async () => {
    const midTurn = vi.fn(async () => {
      /* fail-open: no throw */
    })
    const recordAnchor = vi.fn()
    let streamCalls = 0
    const streamProcessor = {
      run: async (): Promise<TurnStreamResult> => {
        streamCalls++
        if (streamCalls === 1) {
          return {
            kind: 'assistant',
            assistantContent: '',
            toolCalls: [{ id: 't1', name: 'ls', arguments: '{}' }],
            finishReason: 'tool_calls',
            sawUsage: true,
            promptTokens: 500
          }
        }
        return {
          kind: 'assistant',
          assistantContent: 'done',
          toolCalls: [],
          finishReason: 'stop',
          sawUsage: true,
          promptTokens: 600
        }
      }
    }

    const context = createContext([
      { role: 'system', content: 's' },
      { role: 'user', content: 'go' }
    ])
    context.dialect = 'native'

    const executeBatch = async (): Promise<ToolBatchExecutionResult> => ({
      aborted: false,
      outcomes: [{
        index: 0,
        toolCall: { id: 't1', name: 'ls', arguments: '{}' },
        args: {},
        resultText: 'ok',
        failed: false
      }]
    })

    const result = await runAgentLoop({
      messageId: 'm1',
      userText: 'go',
      context,
      config: {
        maxToolRounds: 5,
        toolExecution: 'parallel',
        maxParallelToolCalls: 4,
        supportsVision: false
      },
      streamProcessor: streamProcessor as never,
      hookManager: new HookManager(),
      emit: () => {},
      emitContextBreakdown: () => {},
      signal: () => false,
      abortSignal: () => undefined,
      executeBatch,
      runCompactionIfThreshold: async () => {},
      runMidTurnCompaction: midTurn,
      recordRequestAnchor: recordAnchor,
      updateTokenEstimate: () => {},
      sleep: async () => {},
      onTerminalError: () => {}
    })

    expect(result.ended).toBe('normal')
    expect(midTurn).toHaveBeenCalledTimes(1)
    expect(recordAnchor).toHaveBeenCalled()
    expect(streamCalls).toBe(2)
  })

  it('mid-turn 端口抛错时 fail-open：turn 继续且仍发下一轮请求', async () => {
    const midTurn = vi.fn(async () => {
      throw new Error('mid-turn boom')
    })
    let streamCalls = 0
    const streamProcessor = {
      run: async (): Promise<TurnStreamResult> => {
        streamCalls++
        if (streamCalls === 1) {
          return {
            kind: 'assistant',
            assistantContent: '',
            toolCalls: [{ id: 't1', name: 'ls', arguments: '{}' }],
            finishReason: 'tool_calls',
            sawUsage: true,
            promptTokens: 100
          }
        }
        return {
          kind: 'assistant',
          assistantContent: 'continued',
          toolCalls: [],
          finishReason: 'stop',
          sawUsage: true,
          promptTokens: 120
        }
      }
    }
    const context = createContext([
      { role: 'system', content: 's' },
      { role: 'user', content: 'go' }
    ])
    context.dialect = 'native'

    const result = await runAgentLoop({
      messageId: 'm2',
      userText: 'go',
      context,
      config: {
        maxToolRounds: 5,
        toolExecution: 'parallel',
        maxParallelToolCalls: 4,
        supportsVision: false
      },
      streamProcessor: streamProcessor as never,
      hookManager: new HookManager(),
      emit: () => {},
      emitContextBreakdown: () => {},
      signal: () => false,
      abortSignal: () => undefined,
      executeBatch: async () => ({
        aborted: false,
        outcomes: [{
          index: 0,
          toolCall: { id: 't1', name: 'ls', arguments: '{}' },
          args: {},
          resultText: 'ok',
          failed: false
        }]
      }),
      runCompactionIfThreshold: async () => {},
      runMidTurnCompaction: midTurn,
      updateTokenEstimate: () => {},
      sleep: async () => {},
      onTerminalError: () => {}
    })

    expect(result.ended).toBe('normal')
    expect(result.cancelled).toBeUndefined()
    expect(midTurn).toHaveBeenCalledTimes(1)
    expect(streamCalls).toBe(2)
  })
})
