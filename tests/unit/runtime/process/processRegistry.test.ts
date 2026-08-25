/**
 * 进程登记表单测：全部使用伪造 child 与闭包，绝不真 spawn。
 * 保护围栏、容量上限、终态幂等、终止超时与范围清理的安全属性。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_ACTIVE_PROCESSES_PER_SESSION,
  ProcessRegistry,
  RETAINED_UNREAD_CAP_BYTES,
  type SessionHandle
} from '../../../../src/runtime/process/registry'
import {
  ProcessSessionError,
  type ProcessErrorCode,
  type RegisterProcessInput
} from '../../../../src/runtime/process/types'

type FakeChild = RegisterProcessInput['child'] & {
  emitClose(exitCode: number | null): void
  emitError(): void
}

function fakeChild(opts: { exitCode?: number | null; signalCode?: string | null } = {}): FakeChild {
  const listeners: { close: Array<() => void>; error: Array<() => void> } = { close: [], error: [] }
  return {
    exitCode: opts.exitCode ?? null,
    signalCode: opts.signalCode ?? null,
    once(event, listener) {
      listeners[event].push(listener)
    },
    emitClose(exitCode) {
      this.exitCode = exitCode
      for (const l of listeners.close.splice(0)) l()
    },
    emitError() {
      for (const l of listeners.error.splice(0)) l()
    }
  }
}

function makeInput(overrides: Partial<RegisterProcessInput> = {}): RegisterProcessInput {
  return {
    owner: { sessionId: 'sess-A', runId: 'run-1' },
    source: 'main-run',
    command: 'ping forever',
    workdir: 'D:/ws',
    destructive: false,
    seedOutput: '',
    killTree: async () => {},
    writeStdin: async () => {},
    child: fakeChild(),
    checkpointBaseline: null,
    ...overrides
  }
}

function expectCode(fn: () => unknown, code: ProcessErrorCode): ProcessSessionError {
  try {
    fn()
  } catch (e) {
    if (e instanceof ProcessSessionError) {
      expect(e.code).toBe(code)
      return e
    }
    throw new Error(`抛出了非 ProcessSessionError: ${String(e)}`)
  }
  throw new Error('预期抛出 ProcessSessionError 但未抛出')
}

describe('ProcessRegistry', () => {
  let registry: ProcessRegistry

  beforeEach(() => {
    registry = new ProcessRegistry()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('settle 前排空 flushPendingOutput：滞留的无尾换行行不丢失且只排一次', () => {
    let flushCalls = 0
    const child = fakeChild()
    const handle = registry.register(
      makeInput({
        child,
        flushPendingOutput: () => {
          flushCalls += 1
          return '>>> '
        }
      })
    )
    child.emitClose(0)
    handle.settle(0)
    expect(flushCalls).toBe(1)
    const { page, state, exitCode } = registry.readPage(handle.ref, 'sess-A')
    expect(state).toBe('exited')
    expect(exitCode).toBe(0)
    expect(page.text).toContain('>>> ')
  })

  it('登记返回随机 psn_ ref（不暴露 PID），describe 透传登记信息', () => {
    const h1 = registry.register(makeInput())
    const h2 = registry.register(makeInput())
    expect(h1.ref).toMatch(/^psn_[A-Za-z0-9_-]{12}$/)
    expect(h2.ref).toMatch(/^psn_[A-Za-z0-9_-]{12}$/)
    expect(h1.ref).not.toBe(h2.ref)
    expect(registry.describe(h1.ref, 'sess-A')).toEqual({
      state: 'running',
      exitCode: null,
      command: 'ping forever',
      source: 'main-run',
      destructive: false,
      owner: { sessionId: 'sess-A', runId: 'run-1' }
    })
  })

  it('同一会话第 9 个 running 登记被拒（active-limit），已退出记录不占名额', () => {
    const handles: SessionHandle[] = []
    for (let i = 0; i < MAX_ACTIVE_PROCESSES_PER_SESSION; i++) {
      handles.push(registry.register(makeInput()))
    }
    expectCode(() => registry.register(makeInput()), 'active-limit')

    handles[0]?.settle(0)
    const again = registry.register(makeInput())
    expect(registry.describe(again.ref, 'sess-A').state).toBe('running')
  })

  it('已退出记录的未读总量超上限后拒绝新登记，读尽后容量恢复', () => {
    const chunk = 'x'.repeat(48 * 1024)
    const perRecord = Buffer.byteLength(chunk)
    const count = Math.floor(RETAINED_UNREAD_CAP_BYTES / perRecord) + 1
    const handles: SessionHandle[] = []
    for (let i = 0; i < count; i++) {
      const h = registry.register(makeInput())
      h.append(chunk)
      h.settle(0)
      handles.push(h)
    }
    expectCode(() => registry.register(makeInput()), 'retained-bytes-limit')

    // 读尽一个记录释放其未读容量，新登记恢复
    for (;;) {
      const r = registry.readPage(handles[0]!.ref, 'sess-A')
      if (!r.page.hasMore) break
    }
    const revived = registry.register(makeInput())
    expect(registry.describe(revived.ref, 'sess-A').state).toBe('running')
  })

  it('围栏：ref 未知与越权是不同错误码', () => {
    const h = registry.register(makeInput())
    expectCode(() => registry.readPage(h.ref, 'sess-B'), 'not-authorized')
    expectCode(() => registry.readPage('psn_aaaaaaaaaaaa', 'sess-A'), 'unknown-ref')
    expectCode(() => registry.readPage('not-a-ref', 'sess-A'), 'unknown-ref')
    expectCode(() => registry.writeInput('psn_aaaaaaaaaaaa', 'sess-A', 'x'), 'unknown-ref')
  })

  it('注册瞬间 child 已退出则直接以 exited 登记且 seed 可读', () => {
    const h = registry.register(
      makeInput({ child: fakeChild({ exitCode: 3 }), seedOutput: 'final output\n' })
    )
    expect(registry.describe(h.ref, 'sess-A')).toMatchObject({ state: 'exited', exitCode: 3 })
    const r = registry.readPage(h.ref, 'sess-A')
    expect(r.state).toBe('exited')
    expect(r.exitCode).toBe(3)
    expect(r.page.text).toBe('final output\n')
    expect(r.page.hasMore).toBe(false)
  })

  it('child 事件与调用方 settle 双通道幂等，首个到达的终态胜出', () => {
    const child1 = fakeChild()
    const h1 = registry.register(makeInput({ child: child1 }))
    child1.emitClose(0)
    h1.settle(1)
    h1.append('late\n')
    const d1 = registry.describe(h1.ref, 'sess-A')
    expect(d1.exitCode).toBe(0)
    expect(registry.readPage(h1.ref, 'sess-A').page.text).toBe('')

    const child2 = fakeChild()
    const h2 = registry.register(makeInput({ child: child2 }))
    h2.settle(2)
    child2.emitClose(3)
    expect(registry.describe(h2.ref, 'sess-A').exitCode).toBe(2)
  })

  it('child error 事件同样触发终态登记', () => {
    const child = fakeChild()
    const h = registry.register(makeInput({ child }))
    child.emitError()
    expect(registry.describe(h.ref, 'sess-A')).toMatchObject({ state: 'exited', exitCode: null })
  })

  it('向已退出进程 write 抛 process-exited，未读输出不丢', () => {
    const child = fakeChild()
    const h = registry.register(makeInput({ child }))
    h.append('partial output\n')
    child.emitClose(1)
    expectCode(() => registry.writeInput(h.ref, 'sess-A', 'more\n'), 'process-exited')
    const r = registry.readPage(h.ref, 'sess-A')
    expect(r.page.text).toBe('partial output\n')
    expect(r.state).toBe('exited')
    expect(r.exitCode).toBe(1)
  })

  it('interrupt 无能力时抛 unsupported-on-windows 并提示改用 stop；有能力时调用闭包', () => {
    const h1 = registry.register(makeInput())
    const err = expectCode(() => registry.interrupt(h1.ref, 'sess-A'), 'unsupported-on-windows')
    expect(err.message).toContain('stop')

    let called = 0
    const h2 = registry.register(makeInput({ interrupt: () => { called += 1; return true } }))
    const r = registry.interrupt(h2.ref, 'sess-A')
    expect(called).toBe(1)
    expect(r.state).toBe('running')
  })

  it('running 会话 stop 返回尾页与退出码，重复 stop 幂等且 killTree 只调一次', async () => {
    let kills = 0
    const child = fakeChild()
    const h = registry.register(
      makeInput({ child, killTree: async () => { kills += 1; child.emitClose(0) } })
    )
    h.append('tail before stop\n')
    const r = await registry.stopSession(h.ref, 'sess-A')
    expect(kills).toBe(1)
    expect(r.exitCode).toBe(0)
    expect(r.page.text).toBe('tail before stop\n')
    expect(registry.describe(h.ref, 'sess-A').state).toBe('exited')

    const again = await registry.stopSession(h.ref, 'sess-A')
    expect(again.exitCode).toBe(0)
    expect(again.page.text).toBe('')
    expect(kills).toBe(1)
  })

  it('已退出的会话 stop 直接成功且不触发 killTree', async () => {
    let kills = 0
    const child = fakeChild()
    const h = registry.register(makeInput({ child, killTree: async () => { kills += 1 } }))
    child.emitClose(7)
    const r = await registry.stopSession(h.ref, 'sess-A')
    expect(r.exitCode).toBe(7)
    expect(kills).toBe(0)
  })

  it('killTree 超时未确认时移除记录并输出诊断，绝不永久等待', async () => {
    const slow = new ProcessRegistry({ terminateTimeoutMs: 20 })
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const h = slow.register(
      makeInput({ command: 'hung-process', killTree: () => new Promise<void>(() => {}) })
    )
    const r = await slow.stopSession(h.ref, 'sess-A')
    expect(r.exitCode).toBeNull()
    expectCode(() => slow.describe(h.ref, 'sess-A'), 'unknown-ref')
    const msg = errSpy.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(msg).toContain(h.ref)
    expect(msg).toContain('hung-process')
  })

  it('killTree 抛出异常按超时路径处理', async () => {
    const slow = new ProcessRegistry({ terminateTimeoutMs: 5000 })
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const h = slow.register(
      makeInput({ killTree: async () => { throw new Error('kill failed') } })
    )
    await slow.stopSession(h.ref, 'sess-A')
    expectCode(() => slow.describe(h.ref, 'sess-A'), 'unknown-ref')
    expect(errSpy).toHaveBeenCalled()
  })

  it('terminateForSession 只终止目标会话，其它会话不受影响', async () => {
    const kills: string[] = []
    const a1 = registry.register(
      makeInput({ command: 'a1', killTree: async () => { kills.push('a1') } })
    )
    const childA2 = fakeChild()
    registry.register(
      makeInput({ child: childA2, command: 'a2', killTree: async () => { kills.push('a2') } })
    )
    childA2.emitClose(0)
    const childB = fakeChild()
    const b = registry.register(
      makeInput({
        owner: { sessionId: 'sess-B', runId: 'run-9' },
        child: childB,
        killTree: async () => { kills.push('b') }
      })
    )
    await registry.terminateForSession('sess-A')
    expectCode(() => registry.describe(a1.ref, 'sess-A'), 'unknown-ref')
    expect(kills).toEqual(['a1'])
    expect(registry.describe(b.ref, 'sess-B').state).toBe('running')
  })

  it('terminateForRun 默认只杀子 agent 记录，includeMainRun 时主 run 一并终止', async () => {
    const main = registry.register(
      makeInput({ command: 'main', owner: { sessionId: 's1', runId: 'r1' } })
    )
    const sub = registry.register(
      makeInput({
        command: 'sub',
        owner: { sessionId: 's1', runId: 'r1' },
        source: 'subagent-run'
      })
    )
    const otherRun = registry.register(
      makeInput({
        command: 'other',
        owner: { sessionId: 's2', runId: 'r2' },
        source: 'subagent-run'
      })
    )
    await registry.terminateForRun('r1', { includeMainRun: false })
    expectCode(() => registry.describe(sub.ref, 's1'), 'unknown-ref')
    expect(registry.describe(main.ref, 's1').state).toBe('running')

    await registry.terminateForRun('r1', { includeMainRun: true })
    expectCode(() => registry.describe(main.ref, 's1'), 'unknown-ref')
    expect(registry.describe(otherRun.ref, 's2').state).toBe('running')
  })

  it('terminateAll 清空全部记录', async () => {
    const h1 = registry.register(makeInput())
    const h2 = registry.register(
      makeInput({ owner: { sessionId: 'sess-B', runId: 'run-2' } })
    )
    await registry.terminateAll()
    expectCode(() => registry.describe(h1.ref, 'sess-A'), 'unknown-ref')
    expectCode(() => registry.describe(h2.ref, 'sess-B'), 'unknown-ref')
  })

  it('同记录的 write 按到达顺序串行执行', async () => {
    const order: string[] = []
    const h = registry.register(
      makeInput({
        writeStdin: async (data) => {
          if (data === 'first') await new Promise((r) => setTimeout(r, 30))
          order.push(data)
        }
      })
    )
    const p1 = registry.writeInput(h.ref, 'sess-A', 'first')
    const p2 = registry.writeInput(h.ref, 'sess-A', 'second')
    await Promise.all([p1, p2])
    expect(order).toEqual(['first', 'second'])
  })

  it('checkpoint 基线可读取与更新，且受会话围栏保护', () => {
    const h = registry.register(makeInput())
    expect(registry.getCheckpointBaseline(h.ref, 'sess-A')).toBeNull()
    const baseline = new Map()
    registry.updateCheckpointBaseline(h.ref, 'sess-A', baseline)
    expect(registry.getCheckpointBaseline(h.ref, 'sess-A')).toBe(baseline)
    registry.updateCheckpointBaseline(h.ref, 'sess-A', null)
    expect(registry.getCheckpointBaseline(h.ref, 'sess-A')).toBeNull()
    expectCode(() => registry.getCheckpointBaseline(h.ref, 'sess-B'), 'not-authorized')
  })

  describe('waitForOutput', () => {
    it('已有未读立即返回 data，不等计时', async () => {
      const h = registry.register(makeInput())
      h.append('ready\n')
      await expect(
        registry.waitForOutput(h.ref, 'sess-A', { silenceMs: 10_000, maxMs: 20_000 })
      ).resolves.toBe('data')
    })

    it('静默超时无任何新数据返回 quiet', async () => {
      const h = registry.register(makeInput())
      await expect(
        registry.waitForOutput(h.ref, 'sess-A', { silenceMs: 50, maxMs: 5_000 })
      ).resolves.toBe('quiet')
    })

    it('数据到达后再静默 silenceMs 返回 data；持续喂数据则等待顺延', async () => {
      const h = registry.register(makeInput())
      const result = registry.waitForOutput(h.ref, 'sess-A', {
        silenceMs: 150,
        maxMs: 5_000
      })
      // 先后两次喂数据：第二次重置静默计时，data 只在末次数据静默后返回
      setTimeout(() => h.append('first\n'), 30)
      setTimeout(() => h.append('second\n'), 120)
      await expect(result).resolves.toBe('data')
      const r = registry.readPage(h.ref, 'sess-A')
      expect(r.page.text).toBe('first\nsecond\n')
    })

    it('总时长到 maxMs 返回 cap（即便静默窗口未满）', async () => {
      const h = registry.register(makeInput())
      const result = registry.waitForOutput(h.ref, 'sess-A', {
        silenceMs: 10_000,
        maxMs: 80
      })
      setTimeout(() => h.append('slow\n'), 20)
      await expect(result).resolves.toBe('cap')
    })

    it('等待期间进程终态立即返回 settled；已退出记录直接返回 settled', async () => {
      const h = registry.register(makeInput())
      const result = registry.waitForOutput(h.ref, 'sess-A', {
        silenceMs: 10_000,
        maxMs: 20_000
      })
      setTimeout(() => h.settle(0), 30)
      await expect(result).resolves.toBe('settled')

      const exited = registry.register(makeInput({ child: fakeChild({ exitCode: 0 }) }))
      await expect(
        registry.waitForOutput(exited.ref, 'sess-A', { silenceMs: 50, maxMs: 100 })
      ).resolves.toBe('settled')
    })

    it('abortSignal 触发立即返回 quiet', async () => {
      const h = registry.register(makeInput())
      const controller = new AbortController()
      const result = registry.waitForOutput(h.ref, 'sess-A', {
        silenceMs: 10_000,
        maxMs: 20_000,
        abortSignal: controller.signal
      })
      setTimeout(() => controller.abort(), 30)
      await expect(result).resolves.toBe('quiet')
    })

    it('等待结束后监听器全部清理：后续 append 不再唤醒旧 Promise', async () => {
      const h = registry.register(makeInput())
      await expect(
        registry.waitForOutput(h.ref, 'sess-A', { silenceMs: 40, maxMs: 5_000 })
      ).resolves.toBe('quiet')
      // 旧 Promise 已结算；再喂数据与 settle 只影响 journal 本身，不抛错不悬挂
      h.append('late\n')
      h.settle(0)
      await expect(
        registry.waitForOutput(h.ref, 'sess-A', { silenceMs: 10_000, maxMs: 20_000 })
      ).resolves.toBe('settled')
    })

    it('受会话围栏保护：越权与未知 ref 抛对应错误码', () => {
      const h = registry.register(makeInput())
      expectCode(
        () => registry.waitForOutput(h.ref, 'sess-B', { silenceMs: 10, maxMs: 20 }),
        'not-authorized'
      )
      expectCode(
        () => registry.waitForOutput('psn_aaaaaaaaaaaa', 'sess-A', { silenceMs: 10, maxMs: 20 }),
        'unknown-ref'
      )
    })
  })
})
