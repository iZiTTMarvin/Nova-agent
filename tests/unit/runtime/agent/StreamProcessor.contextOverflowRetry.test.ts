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
import { identitySummaryProjection } from '../../../../src/test-support/builders/identitySummaryProjection'

/** 产出持续 context_overflow 事件的 mock ModelClient */
function createAlwaysOverflowClient(rawError = 'context overflow token limit'): ModelClient {
  return {
    chat(_messages: ChatMessage[], _tools?: ToolDefinition[], _options?: ChatOptions): AsyncIterable<ChatEvent> {
      return (async function* () {
        yield { type: 'context_overflow', rawError }
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
    lastEstimatedTokens: 0,
    compactionState: null,
    skillsTokenBudget: 0
  }
}

/** 构造一个注入了 mock 依赖的 StreamProcessor */
function createProcessor(opts: {
  compactionResult: () => Promise<boolean>
  onCompaction?: (mode: 'standard' | 'aggressive') => void
  /** 溢出文案；用于覆盖 recovery 分类为 failed（不匹配 OVERFLOW_PATTERNS）的 provider 文案 */
  overflowError?: string
}): {
  processor: StreamProcessor
  emitted: AgentEvent[]
  hookManager: HookManager
} {
  const emitted: AgentEvent[] = []
  const client = createAlwaysOverflowClient(opts.overflowError)
  // 用真实 ModelClientPool 包装 mock client，避免手写 pool 的全部方法
  const stubConfig: ModelConfig = {
    baseUrl: 'http://test',
    apiKey: 'test',
    modelId: 'test-model'
  }
  const modelPool = new ModelClientPool({ primary: client, primaryConfig: stubConfig })

  const hookManager = new HookManager()
  const processor = new StreamProcessor({
    modelPool,
    recovery: new RecoveryStateMachine(),
    cacheDiagnostics: new CacheDiagnostics(),
    emit: (e) => { emitted.push(e) },
    emitContextBreakdown: () => {},
    runOverflowCompaction: (mode) => {
      opts.onCompaction?.(mode)
      return opts.compactionResult()
    },
    hookManager
  })

  return { processor, emitted, hookManager }
}

/** 调用 processor.run 一次（模拟 AgentLoop 外层循环的一次迭代） */
async function runOnce(
  processor: StreamProcessor,
  opts: {
    isCancelled?: () => boolean
    requestOverflowImageDegradation?: () => boolean
  } = {}
): Promise<{ kind: string; error?: string }> {
  return processor.run({
    messageId: 'msg_test',
    chatMessages: [{ role: 'user', content: 'hi' }],
    nativeTools: undefined,
    context: createNativeContext(),
    signal: undefined,
    summaryProjection: identitySummaryProjection,
    isCancelled: opts.isCancelled ?? (() => false),
    sleep: () => Promise.resolve(),
    ...(opts.requestOverflowImageDegradation
      ? { requestOverflowImageDegradation: opts.requestOverflowImageDegradation }
      : {})
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

describe('StreamProcessor 溢出图片降级优先级', () => {
  it('降级回调 true：直接重试，不调用压缩', async () => {
    const modes: string[] = []
    const { processor } = createProcessor({
      compactionResult: async () => true,
      onCompaction: mode => modes.push(mode)
    })
    const r = await runOnce(processor, { requestOverflowImageDegradation: () => true })
    expect(r.kind).toBe('retry')
    expect(modes).toEqual([])
  })

  it('降级回调 false：落入标准压缩', async () => {
    const modes: string[] = []
    const { processor } = createProcessor({
      compactionResult: async () => true,
      onCompaction: mode => modes.push(mode)
    })
    const r = await runOnce(processor, { requestOverflowImageDegradation: () => false })
    expect(r.kind).toBe('retry')
    expect(modes).toEqual(['standard'])
  })

  it('降级与压缩共用 3 次封顶', async () => {
    let degrade = true
    const { processor } = createProcessor({ compactionResult: async () => true })
    expect((await runOnce(processor, { requestOverflowImageDegradation: () => degrade })).kind).toBe('retry')
    degrade = false
    expect((await runOnce(processor, { requestOverflowImageDegradation: () => degrade })).kind).toBe('retry')
    expect((await runOnce(processor, { requestOverflowImageDegradation: () => degrade })).kind).toBe('retry')
    // 第 4 次：额度耗尽，即使降级回调可再返回 true 也不再恢复
    degrade = true
    expect((await runOnce(processor, { requestOverflowImageDegradation: () => degrade })).kind).toBe('error')
  })
})

describe('StreamProcessor 溢出恢复的取消终态', () => {
  it('onError hook 期间用户停止 → cancelled，不再进入恢复链', async () => {
    const modes: string[] = []
    const { processor, hookManager } = createProcessor({
      compactionResult: async () => true,
      onCompaction: mode => modes.push(mode)
    })
    let cancelled = false
    hookManager.on('onError', () => { cancelled = true })
    const r = await runOnce(processor, { isCancelled: () => cancelled })
    expect(r.kind).toBe('cancelled')
    expect(modes).toEqual([])
  })

  it('标准压缩期间用户停止 → cancelled，不再启动激进压缩', async () => {
    const modes: string[] = []
    let cancelled = false
    const { processor } = createProcessor({
      compactionResult: async () => { cancelled = true; return true },
      onCompaction: mode => modes.push(mode)
    })
    const r = await runOnce(processor, { isCancelled: () => cancelled })
    expect(r.kind).toBe('cancelled')
    expect(modes).toEqual(['standard'])
  })

  it('激进压缩返回后发现用户停止 → cancelled，不是 error', async () => {
    const modes: string[] = []
    let cancelled = false
    const { processor } = createProcessor({
      compactionResult: async () => false,
      onCompaction: mode => {
        modes.push(mode)
        if (mode === 'aggressive') cancelled = true
      }
    })
    const r = await runOnce(processor, { isCancelled: () => cancelled })
    expect(r.kind).toBe('cancelled')
    expect(modes).toEqual(['standard', 'aggressive'])
  })
})

describe('StreamProcessor 溢出恢复：分类为 failed 的文案', () => {
  // 'prompt is too long' 被客户端识别为溢出，但不匹配 RecoveryStateMachine.OVERFLOW_PATTERNS
  const failedOverflow = 'prompt is too long'

  it('降级先手不剥夺 failed 分类的唯一一次压缩链机会', async () => {
    const modes: string[] = []
    const { processor } = createProcessor({
      overflowError: failedOverflow,
      compactionResult: async () => true,
      onCompaction: mode => modes.push(mode)
    })
    expect((await runOnce(processor, { requestOverflowImageDegradation: () => true })).kind).toBe('retry')
    expect(modes).toEqual([])
    // 集合已非空（降级回调 false）后仍走标准压缩，而不是直接 error
    expect((await runOnce(processor, { requestOverflowImageDegradation: () => false })).kind).toBe('retry')
    expect(modes).toEqual(['standard'])
    // 压缩链已试过仍溢出 → 终止
    const r = await runOnce(processor, { requestOverflowImageDegradation: () => false })
    expect(r.kind).toBe('error')
    expect((r as { error: string }).error).toBe(failedOverflow)
  })

  it('无可降级对象时维持既有语义：首次即压缩、二次终止', async () => {
    const modes: string[] = []
    const { processor } = createProcessor({
      overflowError: failedOverflow,
      compactionResult: async () => true,
      onCompaction: mode => modes.push(mode)
    })
    expect((await runOnce(processor, { requestOverflowImageDegradation: () => false })).kind).toBe('retry')
    expect(modes).toEqual(['standard'])
    expect((await runOnce(processor, { requestOverflowImageDegradation: () => false })).kind).toBe('error')
  })
})
