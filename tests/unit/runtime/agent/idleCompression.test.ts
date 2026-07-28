import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { IdleCompressionTimer } from '../../../../src/runtime/agent/compaction/IdleCompressionTimer'
import { CompactionService } from '../../../../src/runtime/agent/compaction/CompactionService'
import {
  shouldScheduleIdleCompaction,
  getCompactionThreshold,
  IDLE_COMPACTION_MIN_THRESHOLD_RATIO,
  type IdleCompactionScheduleState
} from '../../../../src/runtime/agent/compaction/compaction'
import { AgentLoop } from '../../../../src/runtime/agent/AgentLoop'
import { EventBus } from '../../../../src/runtime/agent/EventBus'
import type { ChatEvent, ChatMessage, ModelClientConfig, ToolDefinition } from '../../../../src/runtime/model/types'
import type { ChatOptions, ModelClient } from '../../../../src/runtime/model/ModelClient'
import { MockModelClient } from '../../../../src/test-support/builders/MockModelClient'
import { ToolRegistry } from '../../../../src/runtime/tools/ToolRegistry'
import type { ToolContext, ToolResult } from '../../../../src/runtime/tools/types'
import { agentRoute } from '../../../../src/runtime/agent/turn'
import { createAgentContext } from '../../../../src/runtime/agent/core/AgentContext'
import { createReadState } from '../../../../src/runtime/tools/editTool'
import { defaultContextBudgetManager } from '../../../../src/runtime/agent/ContextBudgetManager'
import { CacheDiagnostics } from '../../../../src/runtime/model/cacheDiagnostics'

/** 默认「有资格」的调度状态，供 timer 单测走通压缩路径 */
function eligibleScheduleState(
  overrides?: Partial<IdleCompactionScheduleState>
): IdleCompactionScheduleState {
  const contextWindow = 200_000
  const threshold = getCompactionThreshold(contextWindow)
  return {
    context: [{ role: 'system', content: 's' }],
    contextWindow,
    // 超过 60% 硬阈值，通过预筛
    estimatedTokens: Math.floor(threshold * IDLE_COMPACTION_MIN_THRESHOLD_RATIO) + 1,
    idleCompactionInProgress: false,
    disposed: false,
    // 默认可调度档案，便于测 token / disposed / inProgress 与 timer 路径
    profile: { idlePolicy: 'anthropic-short-ttl' },
    ...overrides
  }
}

function createTestRegistry(): ToolRegistry {
  const registry = new ToolRegistry()
  registry.register({
    name: 'ls',
    description: '列出目录',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '目录路径' } }
    },
    async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
      return { success: true, output: `目录内容: ${args.path ?? '.'}` }
    }
  })
  return registry
}

/** 等待所有微任务完成 */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

describe('shouldScheduleIdleCompaction', () => {
  const contextWindow = 200_000
  const threshold = getCompactionThreshold(contextWindow)

  it('短会话（token 远低于硬阈值 60%）不调度', () => {
    expect(
      shouldScheduleIdleCompaction(
        eligibleScheduleState({
          estimatedTokens: Math.floor(threshold * IDLE_COMPACTION_MIN_THRESHOLD_RATIO) - 1
        })
      )
    ).toBe(false)
  })

  it('接近阈值的长会话仍调度', () => {
    expect(
      shouldScheduleIdleCompaction(
        eligibleScheduleState({
          estimatedTokens: Math.floor(threshold * 0.7)
        })
      )
    ).toBe(true)
  })

  it('已有进行中的压缩不重复调度', () => {
    expect(
      shouldScheduleIdleCompaction(eligibleScheduleState({ idleCompactionInProgress: true }))
    ).toBe(false)
  })

  it('disposed 不触发', () => {
    expect(shouldScheduleIdleCompaction(eligibleScheduleState({ disposed: true }))).toBe(false)
  })

  it('provider-managed 跳过闲时调度（即使 token 足够）', () => {
    expect(
      shouldScheduleIdleCompaction(
        eligibleScheduleState({ profile: { idlePolicy: 'provider-managed' } })
      )
    ).toBe(false)
  })

  it('unknown 与 profile 缺失均跳过闲时调度', () => {
    expect(
      shouldScheduleIdleCompaction(eligibleScheduleState({ profile: { idlePolicy: 'unknown' } }))
    ).toBe(false)
    expect(shouldScheduleIdleCompaction(eligibleScheduleState({ profile: null }))).toBe(false)
  })

  it('anthropic-short-ttl 在 token 足够时仍调度', () => {
    expect(
      shouldScheduleIdleCompaction(
        eligibleScheduleState({ profile: { idlePolicy: 'anthropic-short-ttl' } })
      )
    ).toBe(true)
  })
})

describe('IdleCompressionTimer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('delay 到期后恰好触发一次回调', async () => {
    const onElapsed = vi.fn()
    const timer = new IdleCompressionTimer(onElapsed)

    timer.start()
    vi.advanceTimersByTime(IdleCompressionTimer.IDLE_DELAY_MS - 1)
    expect(onElapsed).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(onElapsed).toHaveBeenCalledTimes(1)
  })

  it('delay 内 cancel 后不触发回调', async () => {
    const onElapsed = vi.fn()
    const timer = new IdleCompressionTimer(onElapsed)

    timer.start()
    vi.advanceTimersByTime(100_000)
    timer.cancel()
    vi.advanceTimersByTime(IdleCompressionTimer.IDLE_DELAY_MS)
    expect(onElapsed).not.toHaveBeenCalled()
  })

  it('repeated start/cancel/start 只保留最后一次计时', async () => {
    const onElapsed = vi.fn()
    const timer = new IdleCompressionTimer(onElapsed)

    timer.start()
    vi.advanceTimersByTime(100_000)
    timer.cancel()
    timer.start()
    vi.advanceTimersByTime(50_000)
    timer.start()
    vi.advanceTimersByTime(IdleCompressionTimer.IDLE_DELAY_MS)
    expect(onElapsed).toHaveBeenCalledTimes(1)
  })
})

function createIdleService(
  modelClient: Pick<ModelClient, 'chat'>,
  options?: {
    messages?: ChatMessage[]
    idlePolicy?: 'anthropic-short-ttl' | 'provider-managed' | 'unknown'
    onCompaction?: () => void
  }
) {
  const context = createAgentContext({
    readState: createReadState(),
    messages: options?.messages ?? [
      { role: 'system', content: 'system prompt' },
      ...Array.from({ length: 30 }, (_, index): ChatMessage => ({
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `history-${index}-${'x'.repeat(80)}`
      }))
    ]
  })
  const service = new CompactionService({
    context,
    modelClient,
    contextBudgetManager: defaultContextBudgetManager,
    cacheDiagnostics: new CacheDiagnostics(),
    contextWindow: 100,
    onCompaction: options?.onCompaction,
    getIdleCacheProfile: () => ({
      idlePolicy: options?.idlePolicy ?? 'anthropic-short-ttl'
    })
  })
  return { service, context }
}

describe('CompactionService idle ownership', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it.each([
    ['短上下文', [{ role: 'system', content: 's' }] as ChatMessage[], 'anthropic-short-ttl' as const],
    ['provider-managed', undefined, 'provider-managed' as const],
    ['unknown provider', undefined, 'unknown' as const]
  ])('%s 不进入摘要模型', async (_name, messages, idlePolicy) => {
    const client = new MockModelClient()
    const { service } = createIdleService(client, { messages, idlePolicy })

    service.scheduleIdle()
    await vi.advanceTimersByTimeAsync(IdleCompressionTimer.IDLE_DELAY_MS)
    await flush()

    expect(client.getCalls()).toHaveLength(0)
  })

  it('reset 与 dispose 都会取消尚未开始的摘要', async () => {
    const resetClient = new MockModelClient()
    const resetService = createIdleService(resetClient).service
    resetService.scheduleIdle()
    resetService.reset()

    const disposedClient = new MockModelClient()
    const disposedService = createIdleService(disposedClient).service
    disposedService.scheduleIdle()
    disposedService.dispose()
    expect(disposedService.scheduleIdle()).toBe(false)

    await vi.advanceTimersByTimeAsync(IdleCompressionTimer.IDLE_DELAY_MS)
    await flush()
    expect(resetClient.getCalls()).toHaveLength(0)
    expect(disposedClient.getCalls()).toHaveLength(0)
  })

  it('cancel during summary 会中止独立 idle signal 且不写回 context', async () => {
    let resolveStarted!: () => void
    const started = new Promise<void>(resolve => {
      resolveStarted = resolve
    })
    let resolveAborted!: () => void
    const aborted = new Promise<void>(resolve => {
      resolveAborted = resolve
    })
    const client: Pick<ModelClient, 'chat'> = {
      async *chat(_messages, _tools, options) {
        resolveStarted()
        await new Promise<void>(resolve => {
          options?.abortSignal?.addEventListener('abort', () => {
            resolveAborted()
            resolve()
          }, { once: true })
        })
        yield { type: 'cancelled' }
      }
    }
    const { service, context } = createIdleService(client)
    const original = context.messages

    service.scheduleIdle()
    await vi.advanceTimersByTimeAsync(IdleCompressionTimer.IDLE_DELAY_MS)
    await started
    service.cancelIdle()
    await aborted
    await flush()

    expect(context.messages).toBe(original)
  })

  it('摘要异常后可再次调度并成功压缩', async () => {
    let callCount = 0
    let resolveCompacted!: () => void
    const compacted = new Promise<void>(resolve => {
      resolveCompacted = resolve
    })
    const client: Pick<ModelClient, 'chat'> = {
      async *chat() {
        callCount++
        if (callCount === 1) throw new Error('summary failed')
        yield { type: 'text_delta', delta: 'idle summary' }
        yield { type: 'message_end', finishReason: 'stop' }
      }
    }
    const { service, context } = createIdleService(client, {
      onCompaction: resolveCompacted
    })

    service.scheduleIdle()
    await vi.advanceTimersByTimeAsync(IdleCompressionTimer.IDLE_DELAY_MS)
    await flush()
    service.scheduleIdle()
    await vi.advanceTimersByTimeAsync(IdleCompressionTimer.IDLE_DELAY_MS)
    await compacted

    expect(callCount).toBe(2)
    expect(String(context.messages[0]?.content)).toContain('system prompt')
    expect(context.compactionLevel).toBe(1)
  })

  it('旧摘要忽略 abort 时不会吞掉后续 idle 调度', async () => {
    let callCount = 0
    let resolveFirstStarted!: () => void
    const firstStarted = new Promise<void>(resolve => {
      resolveFirstStarted = resolve
    })
    let releaseFirst!: () => void
    const firstRelease = new Promise<void>(resolve => {
      releaseFirst = resolve
    })
    let resolveCompacted!: () => void
    const compacted = new Promise<void>(resolve => {
      resolveCompacted = resolve
    })
    const client: Pick<ModelClient, 'chat'> = {
      async *chat() {
        callCount++
        if (callCount === 1) {
          resolveFirstStarted()
          await firstRelease
          yield { type: 'text_delta', delta: 'stale summary' }
          yield { type: 'message_end', finishReason: 'stop' }
          return
        }
        yield { type: 'text_delta', delta: 'fresh summary' }
        yield { type: 'message_end', finishReason: 'stop' }
      }
    }
    const { service, context } = createIdleService(client, {
      onCompaction: resolveCompacted
    })

    service.scheduleIdle()
    await vi.advanceTimersByTimeAsync(IdleCompressionTimer.IDLE_DELAY_MS)
    await firstStarted

    service.cancelIdle()
    service.scheduleIdle()
    await vi.advanceTimersByTimeAsync(IdleCompressionTimer.IDLE_DELAY_MS)
    expect(callCount).toBe(1)

    releaseFirst()
    await flush()
    await vi.advanceTimersByTimeAsync(IdleCompressionTimer.IDLE_DELAY_MS)
    await compacted

    expect(callCount).toBe(2)
    expect(context.messages.some(message =>
      String(message.content).includes('fresh summary')
    )).toBe(true)
    expect(context.messages.some(message =>
      String(message.content).includes('stale summary')
    )).toBe(false)
  })

  it('dispose during summary 会阻止晚到摘要写回', async () => {
    let releaseSummary!: () => void
    const summaryRelease = new Promise<void>(resolve => {
      releaseSummary = resolve
    })
    let resolveStarted!: () => void
    const started = new Promise<void>(resolve => {
      resolveStarted = resolve
    })
    const onCompaction = vi.fn()
    const client: Pick<ModelClient, 'chat'> = {
      async *chat() {
        resolveStarted()
        await summaryRelease
        yield { type: 'text_delta', delta: 'late summary' }
        yield { type: 'message_end', finishReason: 'stop' }
      }
    }
    const { service, context } = createIdleService(client, { onCompaction })
    const original = context.messages

    service.scheduleIdle()
    await vi.advanceTimersByTimeAsync(IdleCompressionTimer.IDLE_DELAY_MS)
    await started
    service.dispose()
    releaseSummary()
    await flush()

    expect(context.messages).toBe(original)
    expect(onCompaction).not.toHaveBeenCalled()
  })
})

describe('AgentLoop 空闲压缩集成', () => {
  function createLoop(
    mockClient?: ModelClient,
    config?: ConstructorParameters<typeof AgentLoop>[2]
  ) {
    const client = mockClient ?? new MockModelClient()
    const eventBus = new EventBus()
    const loop = new AgentLoop(client, eventBus, config)
    loop.setToolRegistry(createTestRegistry())
    return { loop, eventBus, client }
  }

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('sendMessage 完成后启动空闲计时器', async () => {
    const client = new MockModelClient()
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'text_delta', delta: '你好' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })

    const { loop } = createLoop(client)
    await loop.sendMessage('hello', agentRoute())

    vi.advanceTimersByTime(IdleCompressionTimer.IDLE_DELAY_MS)
    await flush()

    expect(loop.getState()).toBe('idle')
  })

  it('sendMessage 入口取消正在进行的空闲压缩', async () => {
    const client = new MockModelClient()
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'text_delta', delta: '回复1' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })

    const { loop } = createLoop(client)
    await loop.sendMessage('第一条', agentRoute())

    vi.advanceTimersByTime(200_000)

    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'text_delta', delta: '回复2' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })
    await loop.sendMessage('第二条', agentRoute())

    vi.advanceTimersByTime(IdleCompressionTimer.IDLE_DELAY_MS)
    await flush()

    expect(loop.getState()).toBe('idle')
  })

  it('reset() 清理 timer，不触发压缩', async () => {
    const client = new MockModelClient()
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'text_delta', delta: '回复' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })

    const { loop } = createLoop(client)
    await loop.sendMessage('hello', agentRoute())

    loop.reset()

    vi.advanceTimersByTime(IdleCompressionTimer.IDLE_DELAY_MS)
    await flush()

    expect(loop.getState()).toBe('idle')
  })

  it('dispose 后不会执行已经调度的空闲摘要', async () => {
    const client = new MockModelClient()
    client.updateConfig({
      baseUrl: 'https://api.anthropic.com',
      apiKey: '',
      modelId: 'claude-test'
    })
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'text_delta', delta: '回复' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })

    const { loop } = createLoop(client, { contextWindow: 100 })
    await loop.sendMessage('hello', agentRoute())
    loop.injectHistory(Array.from({ length: 30 }, (_, index): ChatMessage => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `history-${index}-${'x'.repeat(80)}`
    })))
    loop.dispose()
    await vi.advanceTimersByTimeAsync(IdleCompressionTimer.IDLE_DELAY_MS)
    await flush()

    expect(client.getCalls()).toHaveLength(1)
  })

  it('error 退出路径不启动空闲计时器', async () => {
    const idleStart = vi.spyOn(IdleCompressionTimer.prototype, 'start')
    const client = new MockModelClient()
    client.addResponse({
      events: [{ type: 'error', error: '模型调用失败' }]
    })

    const { loop } = createLoop(client)
    await loop.sendMessage('hello', agentRoute())

    expect(loop.getState()).toBe('error')
    expect(idleStart).not.toHaveBeenCalled()
  })

  it('真实 provider profile 为 provider-managed 时跳过空闲摘要', async () => {
    const client = new MockModelClient()
    client.updateConfig({
      baseUrl: 'https://api.deepseek.com',
      apiKey: '',
      modelId: 'deepseek-chat'
    })
    client.addResponse({
      events: [
        { type: 'text_delta', delta: 'active response' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })
    const { loop } = createLoop(client, { contextWindow: 10_000 })
    loop.injectHistory(Array.from({ length: 30 }, (_, index): ChatMessage => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `history-${index}-${'x'.repeat(700)}`
    })))

    await loop.sendMessage('hello', agentRoute())
    await vi.advanceTimersByTimeAsync(IdleCompressionTimer.IDLE_DELAY_MS)
    await flush()

    expect(client.getCalls()).toHaveLength(1)
  })

  it('真实竞态：晚到 idle 摘要不覆盖第二轮且不误杀 active controller', async () => {
    class OverlapModelClient implements ModelClient {
      readonly config: ModelClientConfig = {
        baseUrl: 'https://api.anthropic.com',
        apiKey: '',
        modelId: 'claude-test'
      }
      private callIndex = 0
      private resolveIdleStarted!: () => void
      private resolveActiveStarted!: () => void
      private releaseIdle!: () => void
      private releaseActive!: () => void
      readonly idleStarted = new Promise<void>(resolve => {
        this.resolveIdleStarted = resolve
      })
      readonly activeStarted = new Promise<void>(resolve => {
        this.resolveActiveStarted = resolve
      })
      private readonly idleRelease = new Promise<void>(resolve => {
        this.releaseIdle = resolve
      })
      private readonly activeRelease = new Promise<void>(resolve => {
        this.releaseActive = resolve
      })
      activeSignal: AbortSignal | undefined
      activeMessages: ChatMessage[] = []

      async *chat(
        messages: ChatMessage[],
        _tools?: ToolDefinition[],
        options?: ChatOptions
      ): AsyncIterable<ChatEvent> {
        const callIndex = this.callIndex++
        if (callIndex === 0) {
          yield { type: 'text_delta', delta: 'first response' }
          yield { type: 'message_end', finishReason: 'stop' }
          return
        }
        if (callIndex === 1) {
          this.resolveIdleStarted()
          await this.idleRelease
          yield { type: 'text_delta', delta: 'late idle summary' }
          yield { type: 'message_end', finishReason: 'stop' }
          return
        }

        this.activeSignal = options?.abortSignal
        this.activeMessages = messages
        this.resolveActiveStarted()
        await this.activeRelease
        if (options?.abortSignal?.aborted) {
          yield { type: 'cancelled' }
          return
        }
        yield { type: 'text_delta', delta: 'second response' }
        yield { type: 'message_end', finishReason: 'stop' }
      }

      updateConfig(_config: ModelClientConfig): void {}

      continueIdle(): void {
        this.releaseIdle()
      }

      continueActive(): void {
        this.releaseActive()
      }
    }

    const client = new OverlapModelClient()
    const onCompaction = vi.fn()
    const { loop } = createLoop(client, {
      contextWindow: 10_000,
      onCompaction
    })
    loop.injectHistory(Array.from({ length: 30 }, (_, index): ChatMessage => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `history-${index}-${'x'.repeat(700)}`
    })))

    await loop.sendMessage('first', agentRoute())
    await vi.advanceTimersByTimeAsync(IdleCompressionTimer.IDLE_DELAY_MS)
    await client.idleStarted

    const activePromise = loop.sendMessage('second', agentRoute())
    await client.activeStarted
    client.continueIdle()
    client.continueActive()

    const outcome = await activePromise
    await flush()

    expect(outcome.status).toBe('completed')
    expect(client.activeSignal?.aborted).toBe(false)
    expect(client.activeMessages.some(message =>
      message.role === 'user' && String(message.content).includes('second')
    )).toBe(true)
    expect(loop.getContext().some(message =>
      message.role === 'user' && String(message.content).includes('second')
    )).toBe(true)
    expect(loop.getContext().some(message =>
      String(message.content).includes('late idle summary')
    )).toBe(false)
    expect(onCompaction).not.toHaveBeenCalled()
  })
})
