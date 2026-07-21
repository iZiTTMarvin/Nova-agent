/**
 * T2-1：StreamProcessor 运行时累积 reasoningContent
 *
 * 验收：单个工具轮、并行工具轮、retry、cancel、文本终态都能正确累积或清理。
 * UI thinking_delta 仍透传；reasoning 只进 TurnStreamResult，不改 thinking block 行为。
 */
import { describe, it, expect } from 'vitest'
import { StreamProcessor } from '../../../../src/runtime/agent/stream/StreamProcessor'
import { ModelClientPool } from '../../../../src/runtime/model/ModelClientPool'
import { RecoveryStateMachine } from '../../../../src/runtime/agent/recovery/RecoveryStateMachine'
import { CacheDiagnostics } from '../../../../src/runtime/model/cacheDiagnostics'
import { HookManager } from '../../../../src/runtime/agent/core/HookManager'
import { MockModelClient } from '../../../../src/test-support/builders/MockModelClient'
import { AgentLoop } from '../../../../src/runtime/agent/AgentLoop'
import { EventBus } from '../../../../src/runtime/agent/EventBus'
import { ToolRegistry } from '../../../../src/runtime/tools/ToolRegistry'
import type { ChatEvent, ChatMessage } from '../../../../src/runtime/model/types'
import type { AgentContext } from '../../../../src/runtime/agent/core/AgentContext'
import type { AgentEvent } from '../../../../src/runtime/agent/types'
import type { ModelConfig } from '../../../../src/shared/config'
import type { TurnStreamResult } from '../../../../src/runtime/agent/stream/streamTypes'

function createNativeContext(): AgentContext {
  return {
    messages: [{ role: 'user', content: 'hi' }],
    systemPrompt: '',
    toolRegistry: null,
    dialect: 'native',
    mode: 'default',
    workingDir: null,
    shellPath: undefined,
    binDirs: [],
    sessionStore: null,
    sessionId: null,
    artifactStore: null,
    readState: { readFiles: new Set() } as unknown as AgentContext['readState'],
    compactionLevel: 0,
    userTurnsSinceCompaction: 0,
    lastEstimatedTokens: 0,
    skillsTokenBudget: 0
  }
}

function createProcessor(client: MockModelClient): {
  processor: StreamProcessor
  emitted: AgentEvent[]
} {
  const emitted: AgentEvent[] = []
  const stubConfig: ModelConfig = {
    baseUrl: 'http://test',
    apiKey: 'test',
    modelId: 'test-model'
  }
  const modelPool = new ModelClientPool({ primary: client, primaryConfig: stubConfig })
  const processor = new StreamProcessor({
    modelPool,
    recovery: new RecoveryStateMachine(),
    cacheDiagnostics: new CacheDiagnostics(),
    emit: e => {
      emitted.push(e)
    },
    emitContextBreakdown: () => {},
    runOverflowCompaction: async () => false,
    hookManager: new HookManager()
  })
  return { processor, emitted }
}

async function runOnce(
  processor: StreamProcessor,
  opts?: { isCancelled?: () => boolean }
): Promise<TurnStreamResult> {
  return processor.run({
    messageId: 'msg_r',
    chatMessages: [{ role: 'user', content: 'hi' }] as ChatMessage[],
    nativeTools: undefined,
    context: createNativeContext(),
    signal: undefined,
    isCancelled: opts?.isCancelled ?? (() => false),
    sleep: () => Promise.resolve()
  })
}

describe('T2-1 StreamProcessor：reasoningContent 累积', () => {
  it('单个工具轮：thinking_delta 聚合进 TurnStreamResult.reasoningContent，并透传 UI', async () => {
    const client = new MockModelClient()
    client.addResponse({
      events: [
        { type: 'thinking_delta', delta: '先读文件…' },
        { type: 'thinking_delta', delta: '再决定调用' },
        {
          type: 'tool_call',
          toolCall: { id: 'tc1', name: 'read', arguments: '{"path":"a.ts"}' }
        },
        { type: 'message_end', finishReason: 'tool_calls' }
      ]
    })
    const { processor, emitted } = createProcessor(client)
    const result = await runOnce(processor)

    expect(result.kind).toBe('assistant')
    if (result.kind !== 'assistant') return
    expect(result.reasoningContent).toBe('先读文件…再决定调用')
    expect(result.reasoningProviderId).toBe('generic')
    expect(result.toolCalls).toHaveLength(1)
    expect(result.toolCalls[0].name).toBe('read')
    // UI 仍收到 thinking_delta，并附带当前档案 ID
    const thinkingEvents = emitted.filter(e => e.type === 'thinking_delta')
    expect(thinkingEvents).toHaveLength(2)
    expect(thinkingEvents.every(e => e.type === 'thinking_delta' && e.providerId === 'generic')).toBe(
      true
    )
  })

  it('capability_downgrade：bumpEpoch 一次并产出诊断', async () => {
    const client = new MockModelClient()
    client.addResponse({
      events: [
        {
          type: 'capability_downgrade',
          capability: 'prompt_cache_key',
          detail: 'Unknown parameter: prompt_cache_key'
        },
        { type: 'text_delta', delta: 'ok' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })
    const emitted: AgentEvent[] = []
    const stubConfig: ModelConfig = {
      baseUrl: 'http://test',
      apiKey: 'test',
      modelId: 'test-model'
    }
    const cacheDiagnostics = new CacheDiagnostics()
    const epochBefore = cacheDiagnostics.getPersistState().epochId
    const modelPool = new ModelClientPool({ primary: client, primaryConfig: stubConfig })
    const processor = new StreamProcessor({
      modelPool,
      recovery: new RecoveryStateMachine(),
      cacheDiagnostics,
      emit: e => {
        emitted.push(e)
      },
      emitContextBreakdown: () => {},
      runOverflowCompaction: async () => false,
      hookManager: new HookManager()
    })
    await processor.run({
      messageId: 'msg_cap',
      chatMessages: [{ role: 'user', content: 'hi' }] as ChatMessage[],
      nativeTools: undefined,
      context: createNativeContext(),
      signal: undefined,
      isCancelled: () => false,
      sleep: () => Promise.resolve()
    })

    expect(cacheDiagnostics.getPersistState().epochId).not.toBe(epochBefore)
    expect(cacheDiagnostics.getPersistState().epochReason).toBe('provider_capability_downgrade')
    expect(
      emitted.some(
        e =>
          e.type === 'cache_diagnostic' &&
          e.diagnostic.reason === 'prompt_cache_key_unsupported'
      )
    ).toBe(true)
  })

  it('并行工具轮：同一子轮内多个 tool_call 共享一份聚合 reasoning', async () => {
    const client = new MockModelClient()
    client.addResponse({
      events: [
        { type: 'thinking_delta', delta: '并行读两个文件' },
        {
          type: 'tool_call',
          toolCall: { id: 'tc_a', name: 'read', arguments: '{"path":"a.ts"}' }
        },
        {
          type: 'tool_call',
          toolCall: { id: 'tc_b', name: 'read', arguments: '{"path":"b.ts"}' }
        },
        { type: 'message_end', finishReason: 'tool_calls' }
      ]
    })
    const { processor } = createProcessor(client)
    const result = await runOnce(processor)

    expect(result.kind).toBe('assistant')
    if (result.kind !== 'assistant') return
    expect(result.reasoningContent).toBe('并行读两个文件')
    expect(result.toolCalls).toHaveLength(2)
  })

  it('文本终态：无工具时同样携带 reasoningContent', async () => {
    const client = new MockModelClient()
    client.addResponse({
      events: [
        { type: 'thinking_delta', delta: '思考结论…' },
        { type: 'text_delta', delta: '最终回答' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })
    const { processor } = createProcessor(client)
    const result = await runOnce(processor)

    expect(result.kind).toBe('assistant')
    if (result.kind !== 'assistant') return
    expect(result.assistantContent).toBe('最终回答')
    expect(result.reasoningContent).toBe('思考结论…')
    expect(result.toolCalls).toHaveLength(0)
  })

  it('无 thinking 时不附带 reasoningContent 字段', async () => {
    const client = new MockModelClient()
    client.addResponse({
      events: [
        { type: 'text_delta', delta: '纯文本' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })
    const { processor } = createProcessor(client)
    const result = await runOnce(processor)

    expect(result.kind).toBe('assistant')
    if (result.kind !== 'assistant') return
    expect(result.reasoningContent).toBeUndefined()
  })

  it('retry：失败 attempt 的 reasoning 清空，成功 attempt 不重复拼接', async () => {
    const client = new MockModelClient()
    // 第一次：thinking 后网络错误 → retry
    client.addResponse({
      events: [
        { type: 'thinking_delta', delta: '失败 attempt 的思考' },
        { type: 'error', error: 'network_reset: connection reset' }
      ]
    })
    // 第二次：全新 thinking + 文本
    client.addResponse({
      events: [
        { type: 'thinking_delta', delta: '成功 attempt 的思考' },
        { type: 'text_delta', delta: 'ok' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })
    const { processor } = createProcessor(client)

    const first = await runOnce(processor)
    expect(first.kind).toBe('retry')

    const second = await runOnce(processor)
    expect(second.kind).toBe('assistant')
    if (second.kind !== 'assistant') return
    // 不得拼接失败 attempt 的 reasoning
    expect(second.reasoningContent).toBe('成功 attempt 的思考')
    expect(second.assistantContent).toBe('ok')
  })

  it('cancel：流中取消返回 cancelled，不产出带 reasoning 的 assistant', async () => {
    const client = new MockModelClient()
    let cancelled = false
    // 用自定义 client：yield thinking 后标记取消，再 yield text
    const events: ChatEvent[] = [
      { type: 'thinking_delta', delta: '半截思考' },
      { type: 'text_delta', delta: '半截正文' },
      { type: 'message_end', finishReason: 'stop' }
    ]
    client.addResponse({ events })

    // 覆盖 chat：在 thinking 后置位取消标志
    const origChat = client.chat.bind(client)
    client.chat = async function* (...args) {
      const iter = origChat(...args)
      for await (const ev of iter) {
        yield ev
        if (ev.type === 'thinking_delta') cancelled = true
      }
    }

    const { processor } = createProcessor(client)
    const result = await runOnce(processor, { isCancelled: () => cancelled })
    expect(result.kind).toBe('cancelled')
  })
})

describe('T2-1 AgentLoop：reasoningContent 进入 runtime context', () => {
  it('工具子轮 + 终态子轮均把 reasoningContent 写入 getContext()', async () => {
    const client = new MockModelClient()
    // 子轮 1：thinking + tool
    client.addResponse({
      events: [
        { type: 'thinking_delta', delta: '准备读文件' },
        {
          type: 'tool_call',
          toolCall: { id: 'tc1', name: 'echo', arguments: '{"text":"hi"}' }
        },
        { type: 'message_end', finishReason: 'tool_calls' }
      ]
    })
    // 子轮 2：thinking + 终态文本
    client.addResponse({
      events: [
        { type: 'thinking_delta', delta: '整理结论' },
        { type: 'text_delta', delta: '完成' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })

    const pool = new ModelClientPool({
      primary: client,
      primaryConfig: { baseUrl: '', apiKey: '', modelId: 'test', toolDialect: 'native' }
    })
    const eventBus = new EventBus()
    const loop = new AgentLoop(pool, eventBus, { toolDialectOverride: 'native' })
    const registry = new ToolRegistry()
    registry.register({
      name: 'echo',
      description: 'echo',
      parameters: { type: 'object', properties: {}, additionalProperties: true },
      async execute() {
        return { success: true, output: 'ok' }
      }
    })
    loop.setToolRegistry(registry)

    await loop.sendMessage('go')
    const ctx = loop.getContext()
    const assistants = ctx.filter(m => m.role === 'assistant')
    expect(assistants).toHaveLength(2)
    expect(assistants[0].reasoningContent).toBe('准备读文件')
    expect(assistants[0].toolCalls?.[0].name).toBe('echo')
    expect(assistants[1].reasoningContent).toBe('整理结论')
    expect(assistants[1].content).toBe('完成')
    // 正文不含 reasoning（约束 4）
    expect(assistants[0].content).not.toContain('准备读文件')
    expect(assistants[1].content).not.toContain('整理结论')

    loop.dispose()
  })
})
