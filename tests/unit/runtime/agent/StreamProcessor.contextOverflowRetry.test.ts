/**
 * StreamProcessor — 上下文溢出重试上限单测（C3）
 *
 * 验证目标：压缩"成功"但模型持续溢出时，contextOverflowRetryCount 达到上限（3 次）
 * 后第 4 次直接返回 { kind: 'error' }，不再进入压缩重试，避免 overflow → compact → retry 乒乓死循环。
 *
 * 与 agentLoopGolden §9.11 的区别：golden 测的是"压缩本身失败 → error"，
 * 本测试针对"压缩一直成功但模型一直溢出"的循环——这是 C3 计数器专门防的场景。
 */
import { describe, it, expect } from 'vitest'
import { StreamProcessor } from '../../../../src/runtime/agent/stream/StreamProcessor'
import { ModelClientPool } from '../../../../src/runtime/model/ModelClientPool'
import { RecoveryStateMachine } from '../../../../src/runtime/agent/recovery/RecoveryStateMachine'
import { CacheDiagnostics } from '../../../../src/runtime/model/cacheDiagnostics'
import { HookManager } from '../../../../src/runtime/agent/core/HookManager'
import type { ChatEvent, ChatMessage, ToolDefinition } from '../../../../src/runtime/model/types'
import type { AgentContext } from '../../../../src/runtime/agent/core/AgentContext'
import type { AgentEvent } from '../../../../src/runtime/agent/types'
import type { ModelClient, ChatOptions } from '../../../../src/runtime/model/ModelClient'
import type { ModelConfig } from '../../../../src/shared/config'

/** 产出持续 context_overflow 事件的 mock ModelClient */
function createAlwaysOverflowClient(): ModelClient {
  return {
    chat(_messages: ChatMessage[], _tools?: ToolDefinition[], _options?: ChatOptions): AsyncIterable<ChatEvent> {
      return (async function* () {
        yield { type: 'context_overflow', rawError: 'context overflow token limit' }
      })()
    },
    updateConfig: () => {}
  }
}

/** 构造最小可用的 AgentContext（native 方言，避免触发 XML scanner） */
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

/** 构造一个注入了 mock 依赖的 StreamProcessor */
function createProcessor(opts: { compactionResult: () => Promise<boolean> }): {
  processor: StreamProcessor
  emitted: AgentEvent[]
} {
  const emitted: AgentEvent[] = []
  const client = createAlwaysOverflowClient()
  // 用真实 ModelClientPool 包装 mock client，避免手写 pool 的全部方法
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
    emit: (e) => { emitted.push(e) },
    emitContextBreakdown: () => {},
    runOverflowCompaction: () => opts.compactionResult(),
    hookManager: new HookManager()
  })

  return { processor, emitted }
}

/** 调用 processor.run 一次（模拟 AgentLoop 外层循环的一次迭代） */
async function runOnce(processor: StreamProcessor): Promise<{ kind: string; error?: string }> {
  return processor.run({
    messageId: 'msg_test',
    chatMessages: [{ role: 'user', content: 'hi' }],
    nativeTools: undefined,
    context: createNativeContext(),
    signal: undefined,
    isCancelled: () => false,
    sleep: () => Promise.resolve()
  })
}

describe('StreamProcessor C3：上下文溢出重试上限', () => {
  it('压缩持续成功但模型持续溢出：前 3 次返回 retry，第 4 次返回 error', async () => {
    // 压缩永远"成功"——制造 C3 防范的乒乓场景
    const { processor } = createProcessor({ compactionResult: async () => true })

    // C3 不变量：计数器 < 上限时，压缩成功 → retry（外层循环重跑本轮）
    const r1 = await runOnce(processor)
    expect(r1.kind).toBe('retry')

    const r2 = await runOnce(processor)
    expect(r2.kind).toBe('retry')

    const r3 = await runOnce(processor)
    expect(r3.kind).toBe('retry')

    // 第 4 次：contextOverflowRetryCount(3) >= MAX_CONTEXT_OVERFLOW_RETRIES(3)
    // 直接返回 error，不再触发压缩，透传原始错误
    const r4 = await runOnce(processor)
    expect(r4.kind).toBe('error')
    expect((r4 as { error: string }).error).toBe('context overflow token limit')
  })

  it('压缩成功后立即重置计数器（新消息开始），上限不跨轮次累积', async () => {
    const { processor } = createProcessor({ compactionResult: async () => true })

    // 消耗 2 次重试配额
    await runOnce(processor)
    await runOnce(processor)
    // 此时 contextOverflowRetryCount = 2

    // 新消息开始：resetRetryState 把计数器清零
    processor.resetRetryState()

    // 即使之前用过 2 次，新消息的首次溢出仍应 retry（计数器已重置为 0）
    const r = await runOnce(processor)
    expect(r.kind).toBe('retry')
  })

  it('压缩失败时立即返回 error，不受计数器上限约束', async () => {
    // standard 与 aggressive 均失败
    const { processor } = createProcessor({ compactionResult: async () => false })

    const r = await runOnce(processor)
    expect(r.kind).toBe('error')
    expect((r as { error: string }).error).toBe('context overflow token limit')
  })
})
