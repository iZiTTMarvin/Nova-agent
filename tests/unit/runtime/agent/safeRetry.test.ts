/**
 * 安全重试单测。
 *
 * 覆盖安全重试验收标准：
 * - 已产生 tool call / 正文 / reasoning 后的流式错误 → 不重试，走终态失败
 * - 首字节前的网络错误 → 重试，退避序列符合 maka（base 1s，max 32s，jitter 上界 0.25）
 * - Retry-After: <秒数> → 用该值，忽略指数退避
 * - Retry-After: <HTTP-date> → 正确解析
 * - 结构化 ModelFailure 是重试决策的真源，不再依赖字符串正则
 */
import { describe, it, expect } from 'vitest'
import { identitySummaryProjection } from '../../../../src/test-support/builders/identitySummaryProjection'
import {
  parseRetryAfter,
  httpStatusToFailure,
  thrownToFailure,
  formatTransportError
} from '../../../../src/runtime/model/ModelTransport'
import {
  RecoveryStateMachine,
  MAX_RETRY_ATTEMPTS
} from '../../../../src/runtime/agent/recovery/RecoveryStateMachine'
import { AttemptController } from '../../../../src/runtime/agent/recovery/AttemptController'
import { ModelClientPool } from '../../../../src/runtime/model/ModelClientPool'
import type { ModelFailure } from '../../../../src/runtime/model/failureTypes'
import type { ModelClient, ChatOptions } from '../../../../src/runtime/model/ModelClient'
import type { ChatEvent, ChatMessage, ToolDefinition } from '../../../../src/runtime/model/types'
import type { ModelConfig } from '../../../../src/shared/config'

// ── Retry-After 解析 ──────────────────────────────────────

describe('parseRetryAfter', () => {
  it('秒数格式 → 毫秒', () => {
    const headers = new Headers({ 'retry-after': '5' })
    expect(parseRetryAfter(headers)).toBe(5000)
  })

  it('0 秒 → 0', () => {
    const headers = new Headers({ 'retry-after': '0' })
    expect(parseRetryAfter(headers)).toBe(0)
  })

  it('HTTP-date 格式 → 相对当前时间的毫秒数', () => {
    const future = new Date(Date.now() + 30_000).toUTCString()
    const headers = new Headers({ 'retry-after': future })
    const ms = parseRetryAfter(headers)
    expect(ms).not.toBeUndefined()
    // 容忍解析与构造之间的时间漂移
    expect(ms!).toBeGreaterThan(20_000)
    expect(ms!).toBeLessThan(40_000)
  })

  it('过去的 HTTP-date → 0（已到期立即重试）', () => {
    const past = new Date(Date.now() - 60_000).toUTCString()
    const headers = new Headers({ 'retry-after': past })
    expect(parseRetryAfter(headers)).toBe(0)
  })

  it('超过 1h 的值 → undefined（视为网关异常值，回退指数退避）', () => {
    const headers = new Headers({ 'retry-after': '7200' })
    expect(parseRetryAfter(headers)).toBeUndefined()
  })

  it('无头 → undefined', () => {
    expect(parseRetryAfter(new Headers())).toBeUndefined()
    expect(parseRetryAfter(undefined)).toBeUndefined()
  })

  it('非数字非日期 → undefined', () => {
    const headers = new Headers({ 'retry-after': 'not-a-date' })
    expect(parseRetryAfter(headers)).toBeUndefined()
  })
})

// ── httpStatusToFailure ───────────────────────────────────

describe('httpStatusToFailure', () => {
  it('429 → rate_limit + retryable + retryAfterMs', () => {
    const headers = new Headers({ 'retry-after': '10' })
    const f = httpStatusToFailure(429, 'slow down', headers)
    expect(f.kind).toBe('rate_limit')
    expect(f.retryable).toBe(true)
    expect(f.retryAfterMs).toBe(10_000)
  })

  it('503 → provider_unavailable + retryable', () => {
    const f = httpStatusToFailure(503, 'unavailable')
    expect(f.kind).toBe('provider_unavailable')
    expect(f.retryable).toBe(true)
  })

  it('401 → auth + 不可重试', () => {
    const f = httpStatusToFailure(401, 'invalid key')
    expect(f.kind).toBe('auth')
    expect(f.retryable).toBe(false)
  })

  it('402 → provider_billing + 不可重试', () => {
    const f = httpStatusToFailure(402, 'insufficient quota')
    expect(f.kind).toBe('provider_billing')
    expect(f.retryable).toBe(false)
  })

  it('400 → unknown + 不可重试（context overflow 由上层单独判定）', () => {
    const f = httpStatusToFailure(400, 'bad request')
    expect(f.kind).toBe('unknown')
    expect(f.retryable).toBe(false)
  })

  it('x-request-id 被捕获到 requestId（仅诊断）', () => {
    const headers = new Headers({ 'x-request-id': 'req-abc-123' })
    const f = httpStatusToFailure(500, 'boom', headers)
    expect(f.requestId).toBe('req-abc-123')
  })
})

// ── thrownToFailure ───────────────────────────────────────

describe('thrownToFailure', () => {
  it('timeout 类 → timeout + retryable', () => {
    const msg = formatTransportError('timeout_connect', '建连超时')
    const f = thrownToFailure('timeout_connect', msg)
    expect(f.kind).toBe('timeout')
    expect(f.retryable).toBe(true)
  })

  it('network_reset → network + retryable', () => {
    const f = thrownToFailure('network_reset', 'ECONNRESET')
    expect(f.kind).toBe('network')
    expect(f.retryable).toBe(true)
  })
})

// ── RecoveryStateMachine：结构化 failure 优先于字符串 ──────

describe('RecoveryStateMachine：结构化 failure 是决策真源', () => {
  const rsm = new RecoveryStateMachine()

  it('failure.retryable=true 优先于字符串分类', () => {
    // 字符串不含任何瞬态特征，但 failure 标记为 retryable
    const f: ModelFailure = { kind: 'rate_limit', retryable: true, message: 'x' }
    expect(rsm.classify('totally benign string', 0, f).kind).toBe('retrying')
  })

  it('failure.retryable=false 即使字符串含 429 也不重试', () => {
    const f: ModelFailure = { kind: 'auth', retryable: false, message: 'auth' }
    expect(rsm.classify('429 rate limit', 0, f).kind).toBe('failed')
  })

  it('缺 failure 时回退到旧字符串分类', () => {
    expect(rsm.classify('429 rate limit', 0).kind).toBe('retrying')
    expect(rsm.classify('totally benign', 0).kind).toBe('failed')
  })

  it('上限提到 10', () => {
    expect(MAX_RETRY_ATTEMPTS).toBe(10)
  })
})

// ── AttemptController：安全重试门闩 ───────────

/** 构造一个注入确定性随机源（始终取 0）的 AttemptController，便于断言退避序列 */
function createController(opts: {
  random?: () => number
  fallbackCount?: number
}): { controller: AttemptController; pool: ModelClientPool } {
  const stubConfig: ModelConfig = {
    baseUrl: 'http://test',
    apiKey: 'test',
    modelId: 'test-model'
  }
  const client: ModelClient = {
    async *chat(): AsyncIterable<ChatEvent> {
      yield { type: 'message_end', finishReason: 'stop' }
    },
    updateConfig: () => {}
  }
  const fallbacks =
    opts.fallbackCount && opts.fallbackCount > 0
      ? Array.from({ length: opts.fallbackCount }, (_, i) => ({
          config: { ...stubConfig, modelId: `fb-${i}` },
          client
        }))
      : undefined
  const pool = new ModelClientPool({
    primary: client,
    primaryConfig: stubConfig,
    fallbacks
  })
  const controller = new AttemptController({
    recovery: new RecoveryStateMachine(),
    modelPool: pool,
    ...(opts.random !== undefined ? { random: opts.random } : {})
  })
  controller.reset()
  controller.beginAttempt()
  return { controller, pool }
}

describe('AttemptController 安全重试门闩', () => {
  const rateLimitFailure: ModelFailure = {
    kind: 'rate_limit',
    retryable: true,
    message: '429'
  }

  it('首字节前网络错误（无可观察输出）→ 重试', () => {
    const { controller } = createController({ random: () => 0 })
    const decision = controller.onError('network_reset: boom', rateLimitFailure, true)
    expect(decision.action).toBe('retry')
  })

  it('已产生可观察输出（tool call / 正文 / reasoning 任一）后的流式错误 → 不重试', () => {
    // AttemptController 层只看 hasNoObservableOutput 布尔；具体输出类型由 StreamProcessor
    // 集成测试覆盖。这里验证门闩关闭时任何 retryable failure 都不进入重试。
    const { controller } = createController({ random: () => 0 })
    const decision = controller.onError('429 rate limit', rateLimitFailure, false)
    expect(decision.action).not.toBe('retry')
  })

  it('无可观察输出但无 fallback 可切 → 重试耗尽后 fail', () => {
    const { controller } = createController({ random: () => 0 })
    const f: ModelFailure = { kind: 'network', retryable: true, message: 'net' }
    let decision = controller.onError('network_reset', f, true)
    // 连续重试直到上限
    for (let i = 0; i < 9; i++) {
      controller.beginAttempt()
      decision = controller.onError('network_reset', f, true)
    }
    expect(decision.action).toBe('fail')
  })
  it('退避序列：确定性随机=0 时为 1s/2s/4s/8s/16s/32s/32s/32s/32s，第 10 次耗尽失败', () => {
    const { controller } = createController({ random: () => 0 })
    // 前 9 次重试的退避（attempt 1..9）；第 10 次错误 providerAttempt=9 → classify attempt=10，
    // shouldRetry(10<10)=false → 不再重试，走 fallback/fail。
    const expected = [1000, 2000, 4000, 8000, 16000, 32000, 32000, 32000, 32000]
    for (let i = 0; i < 9; i++) {
      const d = controller.onError('network_reset', rateLimitFailure, true)
      expect(d.action).toBe('retry')
      if (d.action === 'retry') {
        expect(d.backoffMs).toBe(expected[i])
      }
      controller.beginAttempt()
    }
    // 第 10 次错误：重试耗尽（无 fallback 时）→ fail
    const last = controller.onError('network_reset', rateLimitFailure, true)
    expect(last.action).toBe('fail')
  })
  it('jitter 上界：random=1（上界）时 backoffMs ≤ base × 1.25', () => {
    const { controller } = createController({ random: () => 1 })
    // attempt=1: base=1000, jitter 上界=250 → backoffMs ≤ 1250
    const d1 = controller.onError('network_reset', rateLimitFailure, true)
    expect(d1.action).toBe('retry')
    if (d1.action === 'retry') {
      expect(d1.backoffMs).toBeLessThanOrEqual(1250)
      expect(d1.backoffMs).toBeGreaterThanOrEqual(1000)
    }
  })

  it('Retry-After: 5000 → backoffMs=5000，忽略指数退避', () => {
    const { controller } = createController({ random: () => 0 })
    const f: ModelFailure = {
      kind: 'rate_limit',
      retryable: true,
      retryAfterMs: 5000,
      message: '429'
    }
    const d = controller.onError('429 rate limit', f, true)
    expect(d.action).toBe('retry')
    if (d.action === 'retry') expect(d.backoffMs).toBe(5000)
  })

  it('Retry-After HTTP-date → backoffMs 为解析的毫秒数', () => {
    const { controller } = createController({ random: () => 0 })
    const f: ModelFailure = {
      kind: 'rate_limit',
      retryable: true,
      retryAfterMs: 12_000,
      message: '429'
    }
    const d = controller.onError('429 rate limit', f, true)
    if (d.action === 'retry') expect(d.backoffMs).toBe(12_000)
  })

  it('有 fallback 时，重试耗尽且瞬态 → 切 fallback', () => {
    const { controller, pool } = createController({ random: () => 0, fallbackCount: 1 })
    // 每次都已产生输出（hasNoObservableOutput=false）→ 不重试，但 providerAttempt 持续递增；
    // 达到 maxAttempts(10) 后 decideFallback 触发切换。
    let d: ReturnType<AttemptController['onError']> | undefined
    for (let i = 0; i < 10; i++) {
      d = controller.onError('429 rate limit', rateLimitFailure, false)
      if (d.action === 'fallback') break
      controller.beginAttempt()
    }
    expect(d?.action).toBe('fallback')
    expect(pool.getActiveFallbackIndex()).toBe(1)
  })
})

// ── StreamProcessor 集成：门闩在生产路径生效 ──────────────

import { StreamProcessor } from '../../../../src/runtime/agent/stream/StreamProcessor'
import { CacheDiagnostics } from '../../../../src/runtime/model/cacheDiagnostics'
import { HookManager } from '../../../../src/runtime/agent/core/HookManager'
import type { AgentContext } from '../../../../src/runtime/agent/core/AgentContext'
import type { AgentEvent } from '../../../../src/runtime/agent/types'

function nativeContext(): AgentContext {
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
    compactionState: null,
    skillsTokenBudget: 0
  }
}

/** 构造 StreamProcessor，注入指定模型事件序列 */
function createProcessor(client: ModelClient): {
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
    runOverflowCompaction: () => Promise.resolve(false),
    hookManager: new HookManager()
  })
  return { processor, emitted }
}

/** 产出「先 text_delta 再 error」的 mock client —— 模拟已产生正文后失败 */
function clientTextThenError(): ModelClient {
  let called = false
  return {
    chat(_m: ChatMessage[], _t?: ToolDefinition[], _o?: ChatOptions): AsyncIterable<ChatEvent> {
      return (async function* () {
        if (!called) {
          called = true
          yield { type: 'text_delta', delta: 'partial answer' }
          yield { type: 'error', error: 'http_retryable: 429 rate limit', failure: { kind: 'rate_limit', retryable: true, message: 'http_retryable: 429 rate limit' } }
          return
        }
        yield { type: 'message_end', finishReason: 'stop' }
      })()
    },
    updateConfig: () => {}
  }
}

/** 产出「先 tool_call 再 error」的 mock client —— 模拟已产生 tool call 后失败 */
function clientToolCallThenError(): ModelClient {
  let called = false
  return {
    chat(): AsyncIterable<ChatEvent> {
      return (async function* () {
        if (!called) {
          called = true
          yield {
            type: 'tool_call',
            toolCall: { id: 'call_1', name: 'bash', arguments: '{}' }
          }
          yield { type: 'error', error: 'http_retryable: 429 rate limit', failure: { kind: 'rate_limit', retryable: true, message: 'http_retryable: 429 rate limit' } }
          return
        }
        yield { type: 'message_end', finishReason: 'stop' }
      })()
    },
    updateConfig: () => {}
  }
}

/** 产出「首字节前直接 error」的 mock client —— 模拟无可观察输出的失败 */
function clientErrorBeforeAnyOutput(): ModelClient {
  let called = 0
  return {
    chat(): AsyncIterable<ChatEvent> {
      return (async function* () {
        called++
        if (called === 1) {
          yield { type: 'error', error: 'http_retryable: 429 rate limit', failure: { kind: 'rate_limit', retryable: true, message: 'http_retryable: 429 rate limit' } }
          return
        }
        yield { type: 'message_start' }
        yield { type: 'text_delta', delta: 'ok after retry' }
        yield { type: 'message_end', finishReason: 'stop' }
      })()
    },
    updateConfig: () => {}
  }
}

async function runOnce(processor: StreamProcessor): Promise<{ kind: string }> {
  return processor.run({
    messageId: 'msg_test',
    chatMessages: [{ role: 'user', content: 'hi' }],
    nativeTools: undefined,
    context: nativeContext(),
    signal: undefined,
    summaryProjection: identitySummaryProjection,
    isCancelled: () => false,
    sleep: () => Promise.resolve()
  })
}

describe('StreamProcessor 安全重试门闩', () => {
  it('已产生正文后的 429 → 不重试（返回 error）', async () => {
    const { processor, emitted } = createProcessor(clientTextThenError())
    const result = await runOnce(processor)
    expect(result.kind).toBe('error')
    // 不应出现第二次 text_delta（重试才会有）
    const textDeltas = emitted.filter(e => e.type === 'text_delta')
    expect(textDeltas).toHaveLength(1)
  })

  it('已产生 tool call 后的 429 → 不重试（返回 error）', async () => {
    const { processor, emitted } = createProcessor(clientToolCallThenError())
    const result = await runOnce(processor)
    expect(result.kind).toBe('error')
    // 只有一次 tool_call，没有重试后的第二次
    const toolCalls = emitted.filter(e => e.type === 'tool_call')
    expect(toolCalls).toHaveLength(1)
  })

  it('首字节前的 429 → 重试（返回 retry）', async () => {
    const { processor } = createProcessor(clientErrorBeforeAnyOutput())
    const result = await runOnce(processor)
    expect(result.kind).toBe('retry')
  })
})
