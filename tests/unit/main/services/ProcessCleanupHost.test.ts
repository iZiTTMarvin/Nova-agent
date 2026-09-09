/**
 * ProcessCleanupHost — run 终态到持久进程终止的接线契约
 */
import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import { join } from 'path'
import { createRunCoordinator } from '../../../../src/runtime/run'
import { processRegistry } from '../../../../src/runtime/process'
import { wireProcessCleanup } from '../../../../src/main/services/ProcessCleanupHost'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/nova-test-userdata') },
  BrowserWindow: class {}
}))

type TerminateForRun = (runId: string, opts: { includeMainRun: boolean }) => Promise<void>

describe('ProcessCleanupHost run 终态接线', () => {
  let tmpDir: string
  let spy: MockInstance<TerminateForRun>

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(join(os.tmpdir(), 'nova-process-cleanup-'))
    spy = vi.spyOn(processRegistry, 'terminateForRun').mockResolvedValue(undefined)
  })

  afterEach(() => {
    spy.mockRestore()
    processRegistry.resetForTests()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  async function driveToTerminal(status: 'cancelled' | 'completed' | 'failed' | 'interrupted'): Promise<string> {
    const coord = createRunCoordinator(join(tmpDir, 'runs'))
    wireProcessCleanup(coord)
    const snap = coord.startRun({ kind: 'agent', workspaceId: '/ws', sessionId: 's1' })
    coord.markRunning(snap.runId)
    coord.commitTerminal({ runId: snap.runId, status })
    // 兜底投递尚未送达的 outbox；已 delivering/delivered 的条目不会被重复投递
    await coord.drainPendingOutbox()
    return snap.runId
  }

  it('用户中止：终止该 run 全部进程会话，且只送达一次', async () => {
    const runId = await driveToTerminal('cancelled')

    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy).toHaveBeenCalledWith(runId, { includeMainRun: true })
  })

  it('终态先提交，outbox 等待终止确认；失败可见且仅显式重试后 delivered', async () => {
    let rejectTermination!: (error: Error) => void
    spy.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectTermination = reject }))
    const coord = createRunCoordinator(join(tmpDir, 'runs'))
    wireProcessCleanup(coord)
    const snap = coord.startRun({ kind: 'agent', workspaceId: '/ws', sessionId: 's1' })
    coord.markRunning(snap.runId)
    coord.commitTerminal({ runId: snap.runId, status: 'cancelled' })
    const cleanupEntry = () => coord.getSnapshot(snap.runId)?.terminalOutbox?.find(entry => entry.hookName === 'onCancel')
    expect(coord.getSnapshot(snap.runId)?.status).toBe('cancelled')
    expect(cleanupEntry()?.status).toBe('delivering')
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      rejectTermination(new Error('process exit not confirmed'))
      await vi.waitFor(() => expect(cleanupEntry()?.status).toBe('failed'))
      expect(cleanupEntry()?.lastError).toContain('process exit not confirmed')
      expect(spy).toHaveBeenCalledTimes(1)
      await coord.drainPendingOutbox(snap.runId)
      expect(cleanupEntry()?.status).toBe('delivered')
      expect(spy).toHaveBeenCalledTimes(2)
    } finally {
      errors.mockRestore()
    }
  })

  it('完成 / 失败 / 中断：只终止 subagent-run 会话，主 run 进程跨 turn 存活', async () => {
    for (const status of ['completed', 'failed', 'interrupted'] as const) {
      spy.mockClear()
      const runId = await driveToTerminal(status)

      expect(spy).toHaveBeenCalledTimes(1)
      expect(spy).toHaveBeenCalledWith(runId, { includeMainRun: false })
    }
  })
})
