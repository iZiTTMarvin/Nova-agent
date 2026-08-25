/**
 * bash 让出边界（持久会话）单测：注入伪造执行后端，绝不起真进程。
 * 保护：边界让出登记、边界竞态、开关回退、容量超限、让出后数据流与既有返回结构。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChildProcess } from 'child_process'
import {
  bashTool,
  setBashOperations,
  setBashYieldBoundaryForTests,
  setPersistentShellEnabled
} from '@runtime/tools/bash'
import type { BashOperations } from '@runtime/tools/bash/types'
import { processRegistry } from '@runtime/process'
import { MAX_ACTIVE_PROCESSES_PER_SESSION } from '@runtime/process'
import type { RegisterProcessInput } from '@runtime/process'
import { createReadState } from '@runtime/tools/editTool'
import type { ToolContext } from '@runtime/tools/types'

/** 与 DEFAULT_YIELD_AFTER_MS 一致的恢复值 */
const DEFAULT_YIELD_BOUNDARY_MS = 120_000
const SESSION_ID = 'sess_bash_session'

/**
 * 伪造 child：满足 register 的最小契约（exitCode/signalCode/once），
 * pid 为 undefined 让 killProcessTree 直接返回。
 */
class FakeChild {
  exitCode: number | null = null
  signalCode: string | null = null
  readonly pid: number | undefined = undefined
  readonly stdin = { write: vi.fn() }
  private readonly listeners: Record<'close' | 'error', Array<() => void>> = { close: [], error: [] }

  once(event: 'close' | 'error', listener: () => void): void {
    this.listeners[event].push(listener)
  }

  kill(): boolean {
    return false
  }

  emitClose(exitCode: number | null): void {
    this.exitCode = exitCode
    for (const l of this.listeners.close.splice(0)) l()
  }
}

interface FakeExecSession {
  child: FakeChild
  push(chunk: Buffer): void
  exit(exitCode: number): void
  fail(err: Error): void
}

/** 伪造执行后端：exec 挂起直到测试显式 exit/fail；abort 时模拟内建后端的杀树拒绝行为 */
function createFakeBackend(): { ops: BashOperations; sessions: FakeExecSession[] } {
  const sessions: FakeExecSession[] = []
  const ops: BashOperations = {
    exec(_command, _cwd, options) {
      const child = new FakeChild()
      options.onChild?.(child as unknown as ChildProcess)
      let resolveExec!: (r: { exitCode: number | null }) => void
      let rejectExec!: (e: Error) => void
      const promise = new Promise<{ exitCode: number | null }>((resolve, reject) => {
        resolveExec = resolve
        rejectExec = reject
      })
      options.signal?.addEventListener('abort', () => {
        if (child.exitCode !== null || child.signalCode !== null) return
        child.signalCode = 'SIGTERM'
        child.emitClose(null)
        rejectExec(new Error('The operation was aborted'))
      }, { once: true })
      sessions.push({
        child,
        push: (chunk) => options.onData(chunk),
        exit: (code) => {
          resolveExec({ exitCode: code })
          child.emitClose(code)
        },
        fail: (err) => {
          rejectExec(err)
          child.emitClose(null)
        }
      })
      return promise
    }
  }
  return { ops, sessions }
}
/** 容量预填用的最小登记输入 */
function fillerInput(): RegisterProcessInput {
  return {
    owner: { sessionId: SESSION_ID, runId: 'run_filler' },
    source: 'main-run',
    command: 'filler',
    workdir: 'D:/ws',
    destructive: false,
    seedOutput: '',
    killTree: async () => {},
    writeStdin: async () => {},
    child: new FakeChild(),
    checkpointBaseline: null
  }
}

function createContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workingDir: process.cwd(),
    readState: createReadState(),
    sessionId: SESSION_ID,
    runId: 'run_bash_session',
    ...overrides
  }
}

describe('bashTool 持久会话（让出边界）', () => {
  beforeEach(() => {
    processRegistry.resetForTests()
    setBashYieldBoundaryForTests(50)
    setPersistentShellEnabled(true)
  })

  afterEach(() => {
    setBashOperations(null)
    setBashYieldBoundaryForTests(DEFAULT_YIELD_BOUNDARY_MS)
    setPersistentShellEnabled(true)
    processRegistry.resetForTests()
    vi.restoreAllMocks()
  })

  it('进程在边界前退出：返回结构同现状，不发 processHandle', async () => {
    const { ops, sessions } = createFakeBackend()
    setBashOperations(ops)
    const promise = bashTool.execute({ command: 'echo ok' }, createContext())
    await vi.waitFor(() => expect(sessions.length).toBe(1))
    sessions[0].push(Buffer.from('ok\n'))
    sessions[0].exit(0)

    const result = await promise
    expect(result.success).toBe(true)
    expect(result.exitCode).toBe(0)
    expect(result.output).toContain('ok')
    expect(result.processHandle).toBeUndefined()
  })

  it('边界到点进程仍存活：登记为持久会话并返回 ref 提示行', async () => {
    const { ops, sessions } = createFakeBackend()
    setBashOperations(ops)
    const promise = bashTool.execute({ command: 'long-running' }, createContext())
    await vi.waitFor(() => expect(sessions.length).toBe(1))
    sessions[0].push(Buffer.from('early output\n'))

    const result = await promise
    expect(result.success).toBe(true)
    expect(result.processHandle?.state).toBe('running')
    const ref = result.processHandle!.ref
    expect(ref).toMatch(/^psn_/)
    // 预让出窗口的输出与续操作指引都进入首页交付
    expect(result.output).toContain('early output')
    expect(result.output).toContain(ref)
    expect(result.output).toContain('shell_session')

    expect(processRegistry.describe(ref, SESSION_ID).state).toBe('running')
    // 首页已在 execute 内消费；此后 readPage 追增量（见下一条用例）
    const first = processRegistry.readPage(ref, SESSION_ID)
    expect(first.state).toBe('running')
    expect(first.page.text).toBe('')
  })

  it('边界竞态：child 已退出但 exec 未 resolve → 不注册，内联返回退出码', async () => {    const { ops, sessions } = createFakeBackend()
    setBashOperations(ops)
    const promise = bashTool.execute({ command: 'race' }, createContext())
    await vi.waitFor(() => expect(sessions.length).toBe(1))

    // 20ms：先置 child.exitCode（不 resolve exec）；50ms 边界触发时进程已退出
    setTimeout(() => { sessions[0].child.exitCode = 0 }, 20)
    // 120ms：边界之后 exec 才 resolve
    setTimeout(() => { sessions[0].exit(0) }, 120)

    const result = await promise
    expect(result.processHandle).toBeUndefined()
    expect(result.success).toBe(true)
    expect(result.exitCode).toBe(0)
  })

  it('进程退出时净化器滞留的无尾换行行（REPL 提示符）不丢失', async () => {
    const { ops, sessions } = createFakeBackend()
    setBashOperations(ops)
    const promise = bashTool.execute({ command: 'python' }, createContext())
    await vi.waitFor(() => expect(sessions.length).toBe(1))

    const result = await promise
    const ref = result.processHandle!.ref
    // 无换行的提示符被净化器按行缓冲；settle 必须经 flushPendingOutput 把它入账
    sessions[0].push(Buffer.from('>>> '))
    sessions[0].exit(0)
    await vi.waitFor(() =>
      expect(processRegistry.describe(ref, SESSION_ID).state).toBe('exited')
    )
    const page = processRegistry.readPage(ref, SESSION_ID)
    expect(page.page.text).toContain('>>> ')
  })

  it('持久会话开关关闭：边界到点退回旧超时语义', async () => {
    setPersistentShellEnabled(false)
    const { ops, sessions } = createFakeBackend()
    setBashOperations(ops)
    const promise = bashTool.execute({ command: 'long-running' }, createContext())
    await vi.waitFor(() => expect(sessions.length).toBe(1))

    const result = await promise
    expect(result.success).toBe(false)
    expect(result.error).toContain('超时')
    expect(result.processHandle).toBeUndefined()
    // abort 已到达执行后端（等价于杀树信号）
    expect(sessions[0].child.signalCode).toBe('SIGTERM')
  })

  it('registry 容量超限：让出失败并明确报错，不静默淘汰已有会话', async () => {
    for (let i = 0; i < MAX_ACTIVE_PROCESSES_PER_SESSION; i++) {
      processRegistry.register(fillerInput())
    }
    const { ops } = createFakeBackend()
    setBashOperations(ops)
    const promise = bashTool.execute({ command: 'long-running' }, createContext())

    const result = await promise
    expect(result.success).toBe(false)
    expect(result.error).toContain('上限')
    expect(result.processHandle).toBeUndefined()
  })

  it('让出后的输出继续进入会话日志且被净化（ANSI 剥离）', async () => {
    const { ops, sessions } = createFakeBackend()
    setBashOperations(ops)
    const promise = bashTool.execute({ command: 'long-running' }, createContext())
    await vi.waitFor(() => expect(sessions.length).toBe(1))
    const result = await promise
    const ref = result.processHandle!.ref

    sessions[0].push(Buffer.from('\x1b[31mred-text\x1b[0m\n'))
    const { page } = processRegistry.readPage(ref, SESSION_ID)
    expect(page.text).toContain('red-text')
    expect(page.text).not.toContain('\x1b')
  })

  it('后端 exec 报错（非 abort）：维持现状——命令执行失败', async () => {
    const ops: BashOperations = {
      async exec() {
        throw new Error('spawn ENOENT')
      }
    }
    setBashOperations(ops)
    const result = await bashTool.execute({ command: 'anything' }, createContext())
    expect(result.success).toBe(false)
    expect(result.error).toContain('命令执行失败')
    expect(result.processHandle).toBeUndefined()
  })

  it('schema 不再声明 timeout 参数', () => {
    const properties = bashTool.parameters.properties as Record<string, unknown>
    expect(properties).not.toHaveProperty('timeout')
    expect(Object.keys(properties)).toContain('command')
  })

  it('非零退出码透传不变：success=true 且输出含退出码标注', async () => {
    const { ops, sessions } = createFakeBackend()
    setBashOperations(ops)
    const promise = bashTool.execute({ command: 'failing' }, createContext())
    await vi.waitFor(() => expect(sessions.length).toBe(1))
    sessions[0].push(Buffer.from('boom\n'))
    sessions[0].exit(3)

    const result = await promise
    expect(result.success).toBe(true)
    expect(result.exitCode).toBe(3)
    expect(result.output).toContain('退出码: 3')
    expect(result.processHandle).toBeUndefined()
  })
})
