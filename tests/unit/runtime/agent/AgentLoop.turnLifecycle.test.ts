/**
 * AgentLoop 终态协议测试（阶段 B 行为护栏）
 *
 * 锁定统一 Turn finalizer 的硬约束：
 * - 每轮恰好一个持久化终态事件（completed/cancelled → message_end；failed → error）；
 * - 所有开始过 checkpoint 的轮次都关闭；未 begin 的轮次不调用 endMessage；
 * - hook / 分派执行器 / checkpoint 失败都收敛到结构化 outcome，state 与
 *   currentMessageId 不悬垂（失败后可继续下一轮）；
 * - idle 压缩只在 completed 后调度。
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { AgentLoop } from '../../../../src/runtime/agent/AgentLoop'
import { EventBus } from '../../../../src/runtime/agent/EventBus'
import { MockModelClient } from '../../../../src/test-support/builders/MockModelClient'
import { IdleCompressionTimer } from '../../../../src/runtime/agent/compaction/IdleCompressionTimer'
import { HookManager } from '../../../../src/runtime/agent/core/HookManager'
import type { HookEvent, HookEventResultMap, HookPayload } from '../../../../src/runtime/agent/core/HookManager'
import type { CheckpointManager } from '../../../../src/runtime/checkpoints/CheckpointManager'
import type { AgentEvent } from '../../../../src/runtime/agent/types'
import type { SkillManifest } from '../../../../src/runtime/skills/types'
import { agentRoute } from '../../../../src/runtime/agent/turn'

const loops: AgentLoop[] = []

afterEach(() => {
  while (loops.length) loops.pop()!.dispose()
  vi.restoreAllMocks()
})

function createLoop(client: MockModelClient): { loop: AgentLoop; events: AgentEvent[] } {
  const eventBus = new EventBus()
  const loop = new AgentLoop(client, eventBus)
  loops.push(loop)
  const events: AgentEvent[] = []
  eventBus.on(e => events.push(e))
  return { loop, events }
}

function fakeCheckpoint(): { beginMessage: ReturnType<typeof vi.fn>; endMessage: ReturnType<typeof vi.fn> } {
  return { beginMessage: vi.fn(), endMessage: vi.fn() }
}

function attachCheckpoint(loop: AgentLoop): ReturnType<typeof fakeCheckpoint> {
  const cp = fakeCheckpoint()
  loop.setCheckpointManager(cp as unknown as CheckpointManager)
  return cp
}

function textReply(client: MockModelClient, text = '好的'): void {
  client.addResponse({
    events: [
      { type: 'message_start' },
      { type: 'text_delta', delta: text },
      { type: 'message_end', finishReason: 'stop' }
    ]
  })
}

/** 断言恰好一个持久化终态事件：failed → error；否则 message_end */
function expectExactlyOneTerminal(events: AgentEvent[], kind: 'error' | 'message_end'): void {
  const errors = events.filter(e => e.type === 'error')
  const ends = events.filter(e => e.type === 'message_end')
  if (kind === 'error') {
    expect(errors).toHaveLength(1)
    expect(ends).toHaveLength(0)
  } else {
    expect(ends).toHaveLength(1)
    expect(errors).toHaveLength(0)
  }
}

/** 指定 hook 事件上抛错的 HookManager（模拟宿主注入的异常 hook 层） */
class ThrowingHookManager extends HookManager {
  constructor(private readonly throwOn: HookEvent, private readonly message: string) {
    super()
  }

  override async trigger<E extends HookEvent>(
    payload: Extract<HookPayload, { event: E }>
  ): Promise<HookEventResultMap[E]> {
    if (payload.event === this.throwOn) {
      throw new Error(this.message)
    }
    return super.trigger(payload)
  }
}

describe('终态协议：completed', () => {
  it('纯文本成功 → outcome completed，message_end 恰好一个，checkpoint begin/end 各一次，启动 idle timer', async () => {
    const idleStart = vi.spyOn(IdleCompressionTimer.prototype, 'start')
    const client = new MockModelClient()
    textReply(client)
    const { loop, events } = createLoop(client)
    const cp = attachCheckpoint(loop)

    const outcome = await loop.sendMessage('你好', agentRoute())

    expect(outcome).toEqual({ status: 'completed' })
    expectExactlyOneTerminal(events, 'message_end')
    expect(cp.beginMessage).toHaveBeenCalledTimes(1)
    expect(cp.endMessage).toHaveBeenCalledTimes(1)
    expect(loop.getState()).toBe('idle')
    expect(idleStart).toHaveBeenCalledTimes(1)
  })
})

describe('终态协议：cancelled', () => {
  it('流式期间 cancel → outcome cancelled，message_end(interrupted)，checkpoint 关闭，不启动 idle timer', async () => {
    const idleStart = vi.spyOn(IdleCompressionTimer.prototype, 'start')
    const client = new MockModelClient()
    client.addResponse({
      events: [{ type: 'message_start' }, { type: 'text_delta', delta: '思考中' }]
    })
    const { loop, events } = createLoop(client)
    const cp = attachCheckpoint(loop)

    const pending = loop.sendMessage('hello', agentRoute())
    loop.cancel()
    const outcome = await pending

    expect(outcome).toEqual({ status: 'cancelled' })
    expectExactlyOneTerminal(events, 'message_end')
    const end = events.find(e => e.type === 'message_end') as Extract<AgentEvent, { type: 'message_end' }>
    expect(end.interrupted).toBe(true)
    expect(cp.endMessage).toHaveBeenCalledTimes(1)
    expect(loop.getState()).toBe('cancelled')
    expect(idleStart).not.toHaveBeenCalled()
  })
})

describe('终态协议：模型终态错误', () => {
  it('非瞬态模型错误 → outcome failed，error 恰好一个，checkpoint 仍关闭，不启动 idle timer', async () => {
    const idleStart = vi.spyOn(IdleCompressionTimer.prototype, 'start')
    const client = new MockModelClient()
    client.addResponse({
      events: [{ type: 'message_start' }, { type: 'error', error: 'invalid api key' }]
    })
    const { loop, events } = createLoop(client)
    const cp = attachCheckpoint(loop)

    const outcome = await loop.sendMessage('hi', agentRoute())

    expect(outcome.status).toBe('failed')
    if (outcome.status === 'failed') {
      expect(outcome.error.message).toContain('invalid api key')
    }
    expectExactlyOneTerminal(events, 'error')
    expect(cp.endMessage).toHaveBeenCalledTimes(1)
    expect(loop.getState()).toBe('error')
    expect(idleStart).not.toHaveBeenCalled()
  })
})

describe('终态协议：分派执行器抛错', () => {
  it.each([
    ['xforge', (loop: AgentLoop) => {
      loop.setXForgeRunner(async () => { throw new Error('xforge boom') })
      return { kind: 'xforge' as const, request: 'x', explicitFullDev: false }
    }],
    ['workflow', (loop: AgentLoop) => {
      loop.setWorkflowRunner(async () => { throw new Error('workflow boom') })
      return { kind: 'workflow' as const, scriptName: 's', args: '' }
    }]
  ])('%s runner 抛错 → failed，error 恰好一个且无 message_end，checkpoint 关闭', async (_name, setup) => {
    const client = new MockModelClient()
    const { loop, events } = createLoop(client)
    const cp = attachCheckpoint(loop)
    const onErrorSpy = vi.fn()
    loop.getHookManager().on('onError', onErrorSpy)
    const route = setup(loop)

    const outcome = await loop.sendMessage('x', route)

    expect(outcome.status).toBe('failed')
    expectExactlyOneTerminal(events, 'error')
    expect(cp.endMessage).toHaveBeenCalledTimes(1)
    expect(onErrorSpy).toHaveBeenCalledTimes(1)
    expect(loop.getState()).toBe('error')
  })

  it('fork 执行依赖抛错 → failed，error 恰好一个，checkpoint 关闭', async () => {
    const client = new MockModelClient()
    const { loop, events } = createLoop(client)
    const cp = attachCheckpoint(loop)
    loop.setSkillForkDeps({
      modelClient: client,
      parentEventBus: loop.getEventBus(),
      resolveTool: () => { throw new Error('fork boom') }
    })
    const skill = {
      name: 'f',
      description: 'f',
      directory: '/tmp/f',
      body: 'do it',
      allowedTools: ['ls']
    } as unknown as SkillManifest

    const outcome = await loop.sendMessage('/f', { kind: 'skill_fork', skill, args: '' })

    expect(outcome.status).toBe('failed')
    if (outcome.status === 'failed') {
      expect(outcome.error.message).toContain('fork boom')
    }
    expectExactlyOneTerminal(events, 'error')
    expect(cp.endMessage).toHaveBeenCalledTimes(1)
  })

  it('cancel 后 runner 抛出中断错误 → 收敛为 cancelled，不伪装成 failed', async () => {
    const client = new MockModelClient()
    const { loop, events } = createLoop(client)
    attachCheckpoint(loop)
    loop.setWorkflowRunner(async () => {
      loop.cancel()
      throw new Error('workflow aborted')
    })

    const outcome = await loop.sendMessage('/s', { kind: 'workflow', scriptName: 's', args: '' })

    expect(outcome).toEqual({ status: 'cancelled' })
    expectExactlyOneTerminal(events, 'message_end')
    const end = events.find(e => e.type === 'message_end') as Extract<AgentEvent, { type: 'message_end' }>
    expect(end.interrupted).toBe(true)
  })
})

describe('终态协议：generation fence 与 checkpoint 失败', () => {
  it('generation fence 失效 → failed，不 begin 也不 end checkpoint，state 不悬垂', async () => {
    const client = new MockModelClient()
    textReply(client)
    const { loop, events } = createLoop(client)
    const cp = attachCheckpoint(loop)
    let fenceOk = false
    loop.setExecutionFence(() => fenceOk)

    const outcome = await loop.sendMessage('hi', agentRoute())

    expect(outcome.status).toBe('failed')
    if (outcome.status === 'failed') {
      expect(outcome.error.message).toContain('generation 已失效')
    }
    expectExactlyOneTerminal(events, 'error')
    expect(cp.beginMessage).not.toHaveBeenCalled()
    expect(cp.endMessage).not.toHaveBeenCalled()
    expect(loop.getState()).toBe('error')

    // 失败轮次不得悬垂 running 态：fence 恢复后下一轮必须能正常完成
    fenceOk = true
    const next = await loop.sendMessage('again', agentRoute())
    expect(next).toEqual({ status: 'completed' })
  })

  it('beginMessage 抛错 → failed，且不调用未开始事务的 endMessage', async () => {
    const client = new MockModelClient()
    const { loop, events } = createLoop(client)
    const cp = attachCheckpoint(loop)
    cp.beginMessage.mockImplementation(() => { throw new Error('begin boom') })

    const outcome = await loop.sendMessage('hi', agentRoute())

    expect(outcome.status).toBe('failed')
    expectExactlyOneTerminal(events, 'error')
    expect(cp.endMessage).not.toHaveBeenCalled()
  })

  it('endMessage 抛错（成功轮）→ 收敛为 failed，其余清理继续，下一轮可正常执行', async () => {
    const client = new MockModelClient()
    textReply(client)
    textReply(client, '第二轮')
    const { loop, events } = createLoop(client)
    const cp = attachCheckpoint(loop)
    cp.endMessage.mockImplementationOnce(() => { throw new Error('end boom') })

    const outcome = await loop.sendMessage('hi', agentRoute())

    expect(outcome.status).toBe('failed')
    if (outcome.status === 'failed') {
      expect(outcome.error.message).toContain('end boom')
    }
    expectExactlyOneTerminal(events, 'error')

    const next = await loop.sendMessage('again', agentRoute())
    expect(next).toEqual({ status: 'completed' })
    expect(cp.endMessage).toHaveBeenCalledTimes(2)
  })
})

describe('终态协议：hook 失败', () => {
  it('onMessageStart hook 抛错 → failed，checkpoint 仍关闭，error 恰好一个', async () => {
    const client = new MockModelClient()
    textReply(client)
    const { loop, events } = createLoop(client)
    const cp = attachCheckpoint(loop)
    loop.setHookManager(new ThrowingHookManager('onMessageStart', 'hook start boom'))

    const outcome = await loop.sendMessage('hi', agentRoute())

    expect(outcome.status).toBe('failed')
    if (outcome.status === 'failed') {
      expect(outcome.error.message).toContain('hook start boom')
    }
    expectExactlyOneTerminal(events, 'error')
    expect(cp.endMessage).toHaveBeenCalledTimes(1)
  })

  it('onError hook 抛错 → 原始错误保留，终态收尾不被阻断', async () => {
    const client = new MockModelClient()
    const { loop, events } = createLoop(client)
    const cp = attachCheckpoint(loop)
    loop.setHookManager(new ThrowingHookManager('onError', 'hook error boom'))
    loop.setWorkflowRunner(async () => { throw new Error('original boom') })

    const outcome = await loop.sendMessage('/s', { kind: 'workflow', scriptName: 's', args: '' })

    expect(outcome.status).toBe('failed')
    if (outcome.status === 'failed') {
      expect(outcome.error.message).toBe('original boom')
    }
    const errorEvent = events.find(e => e.type === 'error') as Extract<AgentEvent, { type: 'error' }>
    expect(errorEvent.error).toBe('original boom')
    expectExactlyOneTerminal(events, 'error')
    expect(cp.endMessage).toHaveBeenCalledTimes(1)
  })
})

describe('终态协议：入口互斥', () => {
  it('running 中重复 sendMessage → failed outcome，不产生第二个轮次终态事件', async () => {
    const client = new MockModelClient()
    client.addResponse({
      events: [{ type: 'message_start' }, { type: 'text_delta', delta: '进行中' }]
    })
    const { loop } = createLoop(client)

    const first = loop.sendMessage('first', agentRoute())
    const second = await loop.sendMessage('second', agentRoute())
    expect(second.status).toBe('failed')

    loop.cancel()
    await first
  })
})
