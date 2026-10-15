/**
 * 「费用不确定」失败的有限重放。
 *
 * 已拿到响应头后断流：远端有没有收到、有没有计费无法确认，但模型请求本身没有
 * 本地副作用（工具要等整段流结束才执行）。整轮失败比多计一次费代价更大，所以
 * 这类失败有自己的小预算，且不受「已有可观察输出」门闩限制——半截输出由
 * StreamProcessor 用 attempt_failed 清空后重跑。
 *
 * 同时守住另一半：常规 HTTP 失败（429 之类）即使 retryable，只要已有输出就绝不
 * 重放，避免工具副作用重复执行。
 */
import { describe, it, expect } from 'vitest'
import {
  AttemptController,
  UNCERTAIN_DISPATCH_REPLAY_BUDGET
} from '../../../../src/runtime/agent/recovery/AttemptController'
import { RecoveryStateMachine } from '../../../../src/runtime/agent/recovery/RecoveryStateMachine'
import { ModelClientPool } from '../../../../src/runtime/model/ModelClientPool'
import { thrownToFailure } from '../../../../src/runtime/model/ModelTransport'
import { StreamProcessor } from '../../../../src/runtime/agent/stream/StreamProcessor'
import { CacheDiagnostics } from '../../../../src/runtime/model/cacheDiagnostics'
import { HookManager } from '../../../../src/runtime/agent/core/HookManager'
import { identitySummaryProjection } from '../../../../src/test-support/builders/identitySummaryProjection'
import type { AgentContext } from '../../../../src/runtime/agent/core/AgentContext'
import type { AgentEvent } from '../../../../src/runtime/agent/types'
import type { ModelFailure } from '../../../../src/runtime/model/failureTypes'
import type { ModelClient, ChatOptions } from '../../../../src/runtime/model/ModelClient'
import type { ChatEvent, ChatMessage, ToolDefinition } from '../../../../src/runtime/model/types'
import type { ModelConfig } from '../../../../src/shared/config'
import { encodeModelFailureError } from '../../../../src/shared/model/failureKinds'
import {
  REMOTE_RESULT_UNKNOWN_NOTICE,
  formatTerminalErrorMessage,
  resolveTerminalErrorActions
} from '../../../../src/shared/session/terminalErrorBlocks'

const STUB_CONFIG: ModelConfig = { baseUrl: 'http://test', apiKey: 'test', modelId: 'test-model' }

/** 已拿到响应头后断流：dispatchOutcome='unknown'、retryable=false */
function uncertainFailure(message = 'timeout_idle: 模型语义事件空闲超时'): ModelFailure {
  return thrownToFailure('timeout_idle', message, { headersReceived: true })
}

function createController(): AttemptController {
  const client: ModelClient = {
    async *chat(): AsyncIterable<ChatEvent> {
      yield { type: 'message_end', finishReason: 'stop' }
    },
    updateConfig: () => {}
  }
  const controller = new AttemptController({
    recovery: new RecoveryStateMachine(),
    modelPool: new ModelClientPool({ primary: client, primaryConfig: STUB_CONFIG }),
    random: () => 0
  })
  controller.reset()
  return controller
}

describe('AttemptController：费用不确定失败的有限重放', () => {
  it('无输出时预算内重试，超出预算才终态失败', () => {
    const controller = createController()
    controller.beginAttempt('step-1')

    expect(controller.onError('x', uncertainFailure(), true).action).toBe('retry')
    controller.beginAttempt('step-1')
    expect(controller.onError('x', uncertainFailure(), true).action).toBe('retry')
    controller.beginAttempt('step-1')
    const third = controller.onError('x', uncertainFailure(), true)
    expect(third.action).toBe('fail')
    if (third.action === 'fail') {
      expect(third.kind).toBe('timeout')
      // 用尽后终态不能被展示成可重试的普通网络/超时错误
      const terminal = encodeModelFailureError(third.kind, third.error)
      expect(formatTerminalErrorMessage(terminal)).toBe(REMOTE_RESULT_UNKNOWN_NOTICE)
      expect(resolveTerminalErrorActions(terminal)).toEqual([])
    }
  })

  it('已有可观察输出也重放：模型请求无本地副作用，半截输出会被丢弃', () => {
    const controller = createController()
    controller.beginAttempt('step-1')

    const decision = controller.onError('x', uncertainFailure(), false)
    expect(decision.action).toBe('retry')
    if (decision.action === 'retry') {
      expect(decision.backoffMs).toBeGreaterThan(0)
      expect(decision.hint).toContain('重试')
    }
  })

  it('预算按模型步骤计数：换步骤重新给额度，retry 不刷新额度', () => {
    const controller = createController()
    controller.beginAttempt('step-1')
    controller.onError('x', uncertainFailure(), true)
    controller.beginAttempt('step-1')
    controller.onError('x', uncertainFailure(), true)
    expect(controller.getUncertainDispatchReplayBudget()).toBe(0)

    // 同一步骤的 retry 沿用 step-1 → 已耗尽
    controller.beginAttempt('step-1')
    expect(controller.onError('x', uncertainFailure(), true).action).toBe('fail')

    // 新步骤
    controller.beginAttempt('step-2')
    expect(controller.getUncertainDispatchReplayBudget()).toBe(UNCERTAIN_DISPATCH_REPLAY_BUDGET)
    expect(controller.onError('x', uncertainFailure(), true).action).toBe('retry')
  })

  it('重放预算与常规重试预算互不占用', () => {
    const controller = createController()
    controller.beginAttempt('step-1')
    for (let i = 0; i < UNCERTAIN_DISPATCH_REPLAY_BUDGET; i++) {
      controller.onError('x', uncertainFailure(), true)
      controller.beginAttempt('step-1')
    }
    // 常规瞬态失败仍从 0 起算
    const rateLimit: ModelFailure = { kind: 'rate_limit', retryable: true, message: '429' }
    expect(controller.onError('429', rateLimit, true).action).toBe('retry')
  })

  it('emit 状态与决策一致：预算内是 retrying，用尽是 failed', () => {
    const controller = createController()
    controller.beginAttempt('step-1')
    const failure = uncertainFailure()
    expect(controller.classifyForEmit('x', failure).kind).toBe('retrying')
    controller.onError('x', failure, true)
    controller.beginAttempt('step-1')
    expect(controller.classifyForEmit('x', failure).kind).toBe('retrying')
    controller.onError('x', failure, true)
    controller.beginAttempt('step-1')
    expect(controller.classifyForEmit('x', failure).kind).toBe('failed')
  })

  it('常规可重试失败在已有输出时仍不重放（门闩没有被放宽）', () => {
    const controller = createController()
    controller.beginAttempt('step-1')
    const rateLimit: ModelFailure = { kind: 'rate_limit', retryable: true, message: '429' }
    expect(controller.onError('429', rateLimit, false).action).not.toBe('retry')
  })

  it('未确认送达的失败走常规重试链，不消耗重放预算', () => {
    const controller = createController()
    controller.beginAttempt('step-1')
    const notDispatched = thrownToFailure('network_reset', 'network_reset: fetch failed', {
      headersReceived: false
    })
    expect(controller.onError(notDispatched.message, notDispatched, true).action).toBe('retry')
    expect(controller.getUncertainDispatchReplayBudget()).toBe(UNCERTAIN_DISPATCH_REPLAY_BUDGET)
  })
})

// ── StreamProcessor 集成：断流后重跑，半截输出被丢弃 ──────────

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
    lastEstimatedTokens: 0,
    compactionState: null,
    skillsTokenBudget: 0
  }
}

function createProcessor(client: ModelClient): {
  processor: StreamProcessor
  emitted: AgentEvent[]
} {
  const emitted: AgentEvent[] = []
  const processor = new StreamProcessor({
    modelPool: new ModelClientPool({ primary: client, primaryConfig: STUB_CONFIG }),
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

async function runOnce(processor: StreamProcessor, context = nativeContext()) {
  return processor.run({
    messageId: 'msg_test',
    chatMessages: [{ role: 'user', content: 'hi' }],
    nativeTools: undefined,
    context,
    signal: undefined,
    summaryProjection: identitySummaryProjection,
    isCancelled: () => false,
    sleep: () => Promise.resolve()
  })
}

/** 先吐半截正文再断开连接，第 N 次起成功 */
function clientDisconnectAfterPartial(succeedOnAttempt: number): ModelClient {
  let called = 0
  return {
    chat(_m: ChatMessage[], _t?: ToolDefinition[], _o?: ChatOptions): AsyncIterable<ChatEvent> {
      return (async function* () {
        called++
        if (called < succeedOnAttempt) {
          yield { type: 'text_delta', delta: 'partial answer' }
          throw new Error('socket hang up')
        }
        yield { type: 'message_start' }
        yield { type: 'text_delta', delta: 'full answer' }
        yield { type: 'message_end', finishReason: 'stop' }
      })()
    },
    updateConfig: () => {}
  }
}

describe('StreamProcessor：中途断流自动恢复', () => {
  it.each(['event', 'throw'] as const)('XML 半截工具流经 %s 失败后丢弃旧扫描状态，重放只保留完整调用', async failureMode => {
    let calls = 0
    const client: ModelClient = {
      async *chat(): AsyncIterable<ChatEvent> {
        calls++
        if (calls === 1) {
          yield { type: 'text_delta', delta: '<invoke name="bash"><parameter name="command">echo partial' }
          if (failureMode === 'throw') throw new Error('socket hang up')
          yield { type: 'error', error: 'socket hang up', failure: uncertainFailure() }
          return
        }
        yield { type: 'text_delta', delta: '<invoke name="bash"><parameter name="command">echo complete</parameter></invoke>' }
        yield { type: 'message_end', finishReason: 'stop' }
      },
      updateConfig: () => {}
    }
    const { processor, emitted } = createProcessor(client)
    const context = { ...nativeContext(), dialect: 'xml' as const }
    expect(await runOnce(processor, context)).toMatchObject({ kind: 'retry' })
    const discardedAt = emitted.findIndex(event => event.type === 'attempt_failed')
    expect(discardedAt).toBeGreaterThanOrEqual(0)
    expect(emitted.slice(discardedAt + 1).filter(event => event.type.startsWith('tool_call'))).toEqual([])

    const replay = await runOnce(processor, context)
    expect(replay).toMatchObject({ kind: 'assistant', toolCalls: [{ name: 'bash', arguments: '{"command":"echo complete"}' }] })
    expect(emitted.filter(event => event.type === 'tool_call')).toHaveLength(1)
  })

  it('半截输出后断流 → 重跑并发出 attempt_failed，第二次拿到完整正文', async () => {
    const { processor, emitted } = createProcessor(clientDisconnectAfterPartial(2))
    processor.resetRetryState()

    expect((await runOnce(processor)).kind).toBe('retry')
    expect(emitted.filter(e => e.type === 'attempt_failed')).toHaveLength(1)
    // UI 上是 retrying，不闪 failed 终态
    const states = emitted.filter(e => e.type === 'recovery_state')
    expect(states.some(e => e.type === 'recovery_state' && e.state.kind === 'retrying')).toBe(true)

    const result = await runOnce(processor)
    expect(result.kind).toBe('assistant')
    if (result.kind === 'assistant') expect(result.assistantContent).toBe('full answer')
  })

  it('同一模型步骤连续断流超过预算 → 终态 error，不无限重放', async () => {
    const { processor, emitted } = createProcessor(clientDisconnectAfterPartial(99))
    processor.resetRetryState()

    let result = await runOnce(processor)
    let guard = 0
    while (result.kind === 'retry' && guard < 10) {
      result = await runOnce(processor)
      guard++
    }
    expect(result.kind).toBe('error')
    // 首次错误 + UNCERTAIN_DISPATCH_REPLAY_BUDGET 次重放
    expect(emitted.filter(e => e.type === 'attempt_failed')).toHaveLength(
      UNCERTAIN_DISPATCH_REPLAY_BUDGET
    )
  })
})
