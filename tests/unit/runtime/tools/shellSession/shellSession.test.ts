/**
 * shell_session 工具单测：全部经 processRegistry.register 登记伪造会话（假 child +
 * 可控闭包），绝不真 spawn。保护四个动作的返回形态、游标推进、幂等终态、
 * 越权/未知区分、方案甲滚动基线与 destructive write 的写者租约。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  shellSessionTool,
  setShellSessionWaitForTests
} from '../../../../../src/runtime/tools/shellSession'
import {
  processRegistry,
  type RegisterProcessInput,
  type SessionHandle
} from '../../../../../src/runtime/process'
import { createReadState } from '../../../../../src/runtime/tools/editTool'
import { CheckpointManager } from '../../../../../src/runtime/checkpoints/CheckpointManager'
import { snapshotWorkspace } from '../../../../../src/runtime/checkpoints/snapshot'
import {
  writerLeaseRegistry,
  DEFAULT_LEASE_TIMEOUT_MS
} from '../../../../../src/runtime/workspace'
import type { ToolContext } from '../../../../../src/runtime/tools/types'

type FakeChild = RegisterProcessInput['child'] & {
  emitClose(exitCode: number | null): void
}

function fakeChild(opts: { exitCode?: number | null } = {}): FakeChild {
  const listeners: { close: Array<() => void>; error: Array<() => void> } = { close: [], error: [] }
  return {
    exitCode: opts.exitCode ?? null,
    signalCode: null,
    once(event, listener) {
      listeners[event].push(listener)
    },
    emitClose(exitCode) {
      this.exitCode = exitCode
      for (const l of listeners.close.splice(0)) l()
    }
  }
}

describe('shellSessionTool', () => {
  let tempDir: string
  let writes: string[]

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'nova-shell-session-'))
    writes = []
  })

  afterEach(() => {
    processRegistry.resetForTests()
    writerLeaseRegistry.resetForTests()
    setShellSessionWaitForTests({ silenceMs: 2_000, maxMs: 30_000 })
    vi.useRealTimers()
    rmSync(tempDir, { recursive: true, force: true })
  })

  function registerSession(overrides: Partial<RegisterProcessInput> = {}): SessionHandle {
    return processRegistry.register({
      owner: { sessionId: 'sess-A', runId: 'run-1' },
      source: 'main-run',
      command: 'fake long command',
      workdir: tempDir,
      destructive: false,
      seedOutput: '',
      killTree: async () => {},
      writeStdin: async (data) => {
        writes.push(data)
      },
      child: fakeChild(),
      checkpointBaseline: null,
      ...overrides
    })
  }

  function createContext(overrides: Partial<ToolContext> = {}): ToolContext {
    return {
      workingDir: tempDir,
      readState: createReadState(),
      sessionId: 'sess-A',
      runId: 'run-1',
      ...overrides
    }
  }

  function execute(args: Record<string, unknown>, context = createContext()) {
    return shellSessionTool.execute(args, context)
  }

  it('read 有未读立即返回增量，游标推进不重复旧内容', async () => {
    const h = registerSession({ seedOutput: 'seed output\n' })
    h.append('increment\n')
    const r1 = await execute({ ref: h.ref, action: 'read' })
    expect(r1.success).toBe(true)
    expect(r1.output).toContain('seed output')
    expect(r1.output).toContain('increment')
    expect(r1.processHandle).toEqual({ ref: h.ref, state: 'running' })

    h.append('next chunk\n')
    const r2 = await execute({ ref: h.ref, action: 'read' })
    expect(r2.success).toBe(true)
    expect(r2.output).toContain('next chunk')
    expect(r2.output).not.toContain('seed output')
  })

  it('read 无未读且 running：静默窗口内等到新数据则返回，纯静默返回暂无新输出', async () => {
    setShellSessionWaitForTests({ silenceMs: 150, maxMs: 5_000 })
    const h = registerSession()
    const pending = execute({ ref: h.ref, action: 'read' })
    setTimeout(() => h.append('late data\n'), 50)
    const fed = await pending
    expect(fed.success).toBe(true)
    expect(fed.output).toContain('late data')
    expect(fed.processHandle?.state).toBe('running')

    setShellSessionWaitForTests({ silenceMs: 80, maxMs: 5_000 })
    const quiet = registerSession()
    const r = await execute({ ref: quiet.ref, action: 'read' })
    expect(r.success).toBe(true)
    expect(r.output).toContain('(暂无新输出)')
    expect(r.processHandle?.state).toBe('running')
  })

  it('read 已退出的幂等终态：exitCode 重复一致，读尽后不退化为未知 ref', async () => {
    const child = fakeChild()
    const h = registerSession({ child, seedOutput: 'final line\n' })
    child.emitClose(0)

    const r1 = await execute({ ref: h.ref, action: 'read' })
    expect(r1.success).toBe(true)
    expect(r1.output).toContain('final line')
    expect(r1.output).toContain('会话已结束，退出码: 0')
    expect(r1.exitCode).toBe(0)

    const r2 = await execute({ ref: h.ref, action: 'read' })
    expect(r2.success).toBe(true)
    expect(r2.error).toBeUndefined()
    expect(r2.output).toContain('无更多输出')
    expect(r2.exitCode).toBe(0)
    expect(r2.processHandle).toEqual({ ref: h.ref, state: 'exited' })
  })

  it('write：running 写入原文并确认；exited 拒写且未读输出仍可 read', async () => {
    const h = registerSession()
    const r = await execute({ ref: h.ref, action: 'write', input: 'ping\n' })
    expect(r.success).toBe(true)
    expect(writes).toEqual(['ping\n'])
    expect(r.output).toContain('已写入 5 字节')

    const child = fakeChild()
    const exited = registerSession({ child })
    exited.append('unread before exit\n')
    child.emitClose(1)
    const denied = await execute({ ref: exited.ref, action: 'write', input: 'x\n' })
    expect(denied.success).toBe(false)
    expect(writes).toEqual(['ping\n'])

    const tail = await execute({ ref: exited.ref, action: 'read' })
    expect(tail.success).toBe(true)
    expect(tail.output).toContain('unread before exit')
    expect(tail.exitCode).toBe(1)
  })

  it('interrupt：无闭包（Windows 形态）失败并指向 stop；有闭包成功', async () => {
    const bare = registerSession()
    const denied = await execute({ ref: bare.ref, action: 'interrupt' })
    expect(denied.success).toBe(false)
    expect(denied.error).toContain('stop')

    let called = 0
    const capable = registerSession({
      interrupt: () => {
        called += 1
        return true
      }
    })
    const r = await execute({ ref: capable.ref, action: 'interrupt' })
    expect(r.success).toBe(true)
    expect(called).toBe(1)
    expect(r.output).toContain('中断信号')
    expect(r.processHandle?.state).toBe('running')
  })

  it('stop：终止并返回最终输出与退出码；二次 stop 幂等同终态', async () => {
    let kills = 0
    const child = fakeChild()
    const h = registerSession({
      child,
      killTree: async () => {
        kills += 1
        child.emitClose(0)
      }
    })
    h.append('tail before stop\n')

    const r1 = await execute({ ref: h.ref, action: 'stop' })
    expect(r1.success).toBe(true)
    expect(r1.output).toContain('tail before stop')
    expect(r1.output).toContain('会话已终止，退出码: 0')
    expect(r1.exitCode).toBe(0)
    expect(r1.processHandle).toEqual({ ref: h.ref, state: 'exited' })

    const r2 = await execute({ ref: h.ref, action: 'stop' })
    expect(r2.success).toBe(true)
    expect(r2.exitCode).toBe(0)
    expect(r2.processHandle?.state).toBe('exited')
    expect(kills).toBe(1)
  })

  it('越权与未知 ref 是可区分的失败文案', async () => {
    const h = registerSession()
    const foreign = await execute(
      { ref: h.ref, action: 'read' },
      createContext({ sessionId: 'sess-B' })
    )
    expect(foreign.success).toBe(false)
    expect(foreign.error).toContain('不属于')

    const unknown = await execute({ ref: 'psn_aaaaaaaaaaaa', action: 'read' })
    expect(unknown.success).toBe(false)
    expect(unknown.error).toContain('未知')

    expect(foreign.error).not.toContain('未知')
    expect(unknown.error).not.toContain('不属于')
  })

  it('缺少会话身份直接失败；非法 action / 缺 ref 被拒绝', async () => {
    const noSession = await execute(
      { ref: 'psn_aaaaaaaaaaaa', action: 'read' },
      { workingDir: tempDir, readState: createReadState() }
    )
    expect(noSession.success).toBe(false)
    expect(noSession.error).toContain('会话身份')

    const h = registerSession()
    const badAction = await execute({ ref: h.ref, action: 'explode' })
    expect(badAction.success).toBe(false)
    expect(badAction.error).toContain('action')

    const noRef = await execute({ action: 'read' })
    expect(noRef.success).toBe(false)
    expect(noRef.error).toContain('ref')
  })

  it('会话边界滚动基线：checkpoint 只记上次以来的增量，而不是全量重记', async () => {
    const checkpointDir = join(tempDir, '.checkpoints')
    const manager = new CheckpointManager({
      checkpointDir,
      sessionId: 'sess_cp',
      workspaceRoot: tempDir
    })
    const filePath = join(tempDir, 'watched.txt')
    writeFileSync(filePath, 'one\n', 'utf8')
    const baseline = await snapshotWorkspace(tempDir)
    const h = registerSession({ checkpointBaseline: baseline })
    const spy = vi.spyOn(manager, 'recordBashChange')
    const ctx = createContext({ checkpointManager: manager })

    manager.beginMessage('msg_1')
    writeFileSync(filePath, 'two-two\n', 'utf8')
    await execute({ ref: h.ref, action: 'write', input: 'go\n' }, ctx)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0]?.[0]).toBe(filePath)
    expect((spy.mock.calls[0]?.[1] as Buffer).toString('utf8')).toBe('one\n')

    // 基线已滚动到 two-two：第二次动作只记第二次改动，原始 one 不再重复入账
    manager.beginMessage('msg_2')
    writeFileSync(filePath, 'three\n', 'utf8')
    await execute({ ref: h.ref, action: 'write', input: 'again\n' }, ctx)
    expect(spy).toHaveBeenCalledTimes(2)
    expect((spy.mock.calls[1]?.[1] as Buffer).toString('utf8')).toBe('two-two\n')
    manager.endMessage()
  })

  it('destructive 会话 write 前抢写者租约；非 destructive 会话不抢', async () => {
    await writerLeaseRegistry.acquire(tempDir, 'run-other')

    const destructive = registerSession({ destructive: true })
    vi.useFakeTimers()
    const pending = execute(
      { ref: destructive.ref, action: 'write', input: 'x\n' },
      createContext({ workspaceRoot: tempDir })
    )
    await vi.advanceTimersByTimeAsync(DEFAULT_LEASE_TIMEOUT_MS)
    const conflict = await pending
    vi.useRealTimers()
    expect(conflict.success).toBe(false)
    expect(conflict.output.startsWith('WORKSPACE_CONFLICT')).toBe(true)
    expect(writes).toEqual([])

    const plain = registerSession()
    const ok = await execute(
      { ref: plain.ref, action: 'write', input: 'hi\n' },
      createContext({ workspaceRoot: tempDir })
    )
    expect(ok.success).toBe(true)
    expect(writes).toEqual(['hi\n'])
  })
})
