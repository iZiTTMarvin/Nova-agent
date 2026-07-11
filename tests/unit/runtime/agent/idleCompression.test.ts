import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { IdleCompressionTimer } from '../../../../src/runtime/agent/compaction/IdleCompressionTimer'
import type { IdleCompactionTarget } from '../../../../src/runtime/agent/compaction/IdleCompressionTimer'
import {
  shouldScheduleIdleCompaction,
  getCompactionThreshold,
  IDLE_COMPACTION_MIN_THRESHOLD_RATIO,
  type IdleCompactionScheduleState
} from '../../../../src/runtime/agent/compaction/compaction'
import { AgentLoop } from '../../../../src/runtime/agent/AgentLoop'
import { EventBus } from '../../../../src/runtime/agent/EventBus'
import { MockModelClient } from '../../../../src/test-support/builders/MockModelClient'
import { ToolRegistry } from '../../../../src/runtime/tools/ToolRegistry'
import type { ToolContext, ToolResult } from '../../../../src/runtime/tools/types'

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
    profile: { idlePolicy: 'provider-managed' },
    ...overrides
  }
}

/**
 * 创建一个用于测试的 mock IdleCompactionTarget。
 * 回滚由 target.runIdleCompaction 自己负责（与 AgentLoop.runIdleCompaction 行为一致）。
 * compactionPromise 在压缩完成时 resolve。
 */
function createMockTarget(overrides?: Partial<IdleCompactionTarget>): {
  target: IdleCompactionTarget
  compactionCalls: number
  compactionPromise: Promise<void>
} {
  let compactionCalls = 0
  let resolveCompaction!: () => void
  const compactionPromise = new Promise<void>((r) => {
    resolveCompaction = r
  })

  const target: IdleCompactionTarget = {
    runIdleCompaction: async (_signal: AbortSignal) => {
      compactionCalls++
      resolveCompaction()
    },
    getIdleCompactionScheduleState: () => eligibleScheduleState(),
    ...overrides
  }

  return {
    target,
    get compactionCalls() {
      return compactionCalls
    },
    compactionPromise
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

  it('profile 入口可传入但不影响本轮中性判断', () => {
    expect(
      shouldScheduleIdleCompaction(
        eligibleScheduleState({ profile: { idlePolicy: 'anthropic-short-ttl' } })
      )
    ).toBe(true)
    expect(shouldScheduleIdleCompaction(eligibleScheduleState({ profile: null }))).toBe(true)
  })
})

describe('IdleCompressionTimer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('timer 在 delay 后触发压缩', async () => {
    const mock = createMockTarget()
    const timer = new IdleCompressionTimer(mock.target)

    timer.start()
    expect(mock.compactionCalls).toBe(0)

    vi.advanceTimersByTime(IdleCompressionTimer.IDLE_DELAY_MS)

    await mock.compactionPromise
    await flush()

    expect(mock.compactionCalls).toBe(1)
  })

  it('资格预筛失败时不进入摘要调用', async () => {
    let compactionCalls = 0
    const target: IdleCompactionTarget = {
      runIdleCompaction: async () => {
        compactionCalls++
      },
      getIdleCompactionScheduleState: () =>
        eligibleScheduleState({
          estimatedTokens: 100 // 远低于阈值
        })
    }
    const timer = new IdleCompressionTimer(target)
    timer.start()
    vi.advanceTimersByTime(IdleCompressionTimer.IDLE_DELAY_MS)
    await flush()
    expect(compactionCalls).toBe(0)
  })

  it('start() 后 cancel() 在 delay 内调用 → 压缩不被触发', async () => {
    const mock = createMockTarget()
    const timer = new IdleCompressionTimer(mock.target)

    timer.start()
    vi.advanceTimersByTime(100_000)
    timer.cancel()

    vi.advanceTimersByTime(IdleCompressionTimer.IDLE_DELAY_MS)
    await flush()

    expect(mock.compactionCalls).toBe(0)
  })

  it('压缩运行中 cancel() — timer 层静默吞异常，target 负责回滚', async () => {
    let aborted = false
    const target: IdleCompactionTarget = {
      getIdleCompactionScheduleState: () => eligibleScheduleState(),
      runIdleCompaction: async (signal) => {
        try {
          await new Promise<void>((_resolve, reject) => {
            const onAbort = () => {
              signal.removeEventListener('abort', onAbort)
              reject(new DOMException('aborted', 'AbortError'))
            }
            if (signal.aborted) {
              onAbort()
              return
            }
            signal.addEventListener('abort', onAbort)
          })
        } finally {
          if (signal.aborted) aborted = true
        }
      }
    }

    const timer = new IdleCompressionTimer(target)
    timer.start()

    vi.advanceTimersByTime(IdleCompressionTimer.IDLE_DELAY_MS)
    await flush()

    expect(timer.isCompressing()).toBe(true)

    timer.cancel()
    await flush()

    expect(timer.isCompressing()).toBe(false)
    expect(aborted).toBe(true)
  })

  it('压缩调用触发异常 → 静默失败不抛异常', async () => {
    const target: IdleCompactionTarget = {
      getIdleCompactionScheduleState: () => eligibleScheduleState(),
      runIdleCompaction: async () => {
        throw new Error('context_overflow: prompt is too long')
      }
    }

    const timer = new IdleCompressionTimer(target)
    timer.start()

    vi.advanceTimersByTime(IdleCompressionTimer.IDLE_DELAY_MS)
    await flush()

    expect(timer.isCompressing()).toBe(false)
  })

  it('多次 start-cancel-start 循环 → 计时器状态正确', async () => {
    let compactionCalls = 0
    let resolveCompaction!: () => void
    const makePromise = () =>
      new Promise<void>((r) => {
        resolveCompaction = r
      })

    const mock = createMockTarget({
      runIdleCompaction: async () => {
        compactionCalls++
        resolveCompaction()
      }
    })
    const timer = new IdleCompressionTimer(mock.target)

    timer.start()
    vi.advanceTimersByTime(100_000)
    timer.cancel()
    vi.advanceTimersByTime(IdleCompressionTimer.IDLE_DELAY_MS)
    await flush()
    expect(compactionCalls).toBe(0)

    timer.start()
    vi.advanceTimersByTime(50_000)
    timer.cancel()
    vi.advanceTimersByTime(IdleCompressionTimer.IDLE_DELAY_MS)
    await flush()
    expect(compactionCalls).toBe(0)

    const p = makePromise()
    timer.start()
    vi.advanceTimersByTime(IdleCompressionTimer.IDLE_DELAY_MS)
    await p
    await flush()
    expect(compactionCalls).toBe(1)
  })

  it('reset() 后 timer 被清理', async () => {
    const mock = createMockTarget()
    const timer = new IdleCompressionTimer(mock.target)

    timer.start()
    vi.advanceTimersByTime(100_000)
    timer.cancel()
    vi.advanceTimersByTime(IdleCompressionTimer.IDLE_DELAY_MS)
    await flush()

    expect(mock.compactionCalls).toBe(0)
  })
})

describe('AgentLoop 空闲压缩集成', () => {
  function createLoop(mockClient?: MockModelClient) {
    const client = mockClient ?? new MockModelClient()
    const eventBus = new EventBus()
    const loop = new AgentLoop(client, eventBus)
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
    await loop.sendMessage('hello')

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
    await loop.sendMessage('第一条')

    vi.advanceTimersByTime(200_000)

    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'text_delta', delta: '回复2' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })
    await loop.sendMessage('第二条')

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
    await loop.sendMessage('hello')

    loop.reset()

    vi.advanceTimersByTime(IdleCompressionTimer.IDLE_DELAY_MS)
    await flush()

    expect(loop.getState()).toBe('idle')
  })

  it('dispose 后资格预筛阻断空闲压缩', async () => {
    const client = new MockModelClient()
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'text_delta', delta: '回复' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })

    const { loop } = createLoop(client)
    await loop.sendMessage('hello')

    loop.dispose()
    const state = loop.getIdleCompactionScheduleState()
    expect(state.disposed).toBe(true)
    expect(shouldScheduleIdleCompaction(state)).toBe(false)
  })

  it('error 退出路径也启动空闲计时器', async () => {
    const client = new MockModelClient()
    client.addResponse({
      events: [{ type: 'error', error: '模型调用失败' }]
    })

    const { loop } = createLoop(client)
    await loop.sendMessage('hello')

    expect(loop.getState()).toBe('error')

    vi.advanceTimersByTime(IdleCompressionTimer.IDLE_DELAY_MS)
    await flush()

    expect(loop.getState()).toBe('error')
  })

  it('竞态：cancel 后 sendMessage 推入的用户消息不被回滚误删', async () => {
    const client = new MockModelClient()

    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'text_delta', delta: '回复1' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })

    const { loop } = createLoop(client)
    await loop.sendMessage('第一条')

    const contextBeforeCancel = loop.getContext().length

    const ac = new AbortController()
    const runPromise = loop.runIdleCompaction(ac.signal)

    ac.abort()

    await runPromise.catch(() => {})
    await flush()

    const contextAfterAbort = loop.getContext()
    expect(contextAfterAbort.length).toBe(contextBeforeCancel)
  })
})
