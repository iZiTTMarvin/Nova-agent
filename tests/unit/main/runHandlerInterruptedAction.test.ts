/**
 * runHandler RUN_INTERRUPTED_ACTION 契约：
 * interrupted run 不得经本通道转 resuming（continue 只能由 renderer 代发新消息开新轮次）；
 * rollback / inspect 保持只读语义，不改变 run 状态。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { IpcMainInvokeEvent } from 'electron'

const host = vi.hoisted(() => ({
  tmpUserData: ''
}))

const mockHandle = vi.hoisted(() => vi.fn())
const trustedSender = { mainFrame: {} }

vi.mock('electron', () => ({
  ipcMain: { handle: (...args: unknown[]) => mockHandle(...args) },
  app: { getPath: () => host.tmpUserData },
  BrowserWindow: class BrowserWindow {}
}))

vi.mock('../../../src/main/mainWindowRef', () => ({
  getMainWindow: () => ({ webContents: trustedSender })
}))

import { RUN_INTERRUPTED_ACTION } from '../../../src/shared/ipc/channels'
import { registerRunHandler } from '../../../src/main/ipc/runHandler'
import {
  initRunCoordinatorHost,
  resetRunCoordinatorHostForTests,
  getRunCoordinator
} from '../../../src/main/services/RunCoordinatorHost'

describe('runHandler RUN_INTERRUPTED_ACTION（中断恢复入口）', () => {
  const handles = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>()

  beforeEach(() => {
    host.tmpUserData = mkdtempSync(join(tmpdir(), 'nova-runhandler-'))
    mockHandle.mockReset()
    handles.clear()
    resetRunCoordinatorHostForTests()
    mockHandle.mockImplementation(
      (channel: string, fn: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => {
        handles.set(channel, fn)
      }
    )
    registerRunHandler()
    initRunCoordinatorHost(() => null)
  })

  afterEach(() => {
    resetRunCoordinatorHostForTests()
    rmSync(host.tmpUserData, { recursive: true, force: true })
  })

  async function invoke(params: unknown): Promise<Record<string, unknown>> {
    const event = {
      sender: trustedSender,
      senderFrame: trustedSender.mainFrame
    } as unknown as IpcMainInvokeEvent
    const wrapped = handles.get(RUN_INTERRUPTED_ACTION)!
    return (await wrapped(event, params)) as Record<string, unknown>
  }

  it('continue 动作被拒绝且不产生任何状态事件（无 resuming 死路径）', async () => {
    const coord = getRunCoordinator()
    const snap = coord.startRun({ kind: 'agent', workspaceId: '/ws', sessionId: 's1' })
    coord.markRunning(snap.runId)
    coord.commitTerminal({ runId: snap.runId, status: 'interrupted', reason: 'process_exit' })
    const seqBefore = coord.getSnapshot(snap.runId)!.sequence

    const result = await invoke({
      runId: snap.runId,
      action: 'continue'
    })

    expect(result.ok).toBe(false)
    const after = coord.getSnapshot(snap.runId)!
    expect(after.status).toBe('interrupted')
    expect(after.sequence).toBe(seqBefore)
  })

  it('inspect 返回已记录工具步骤，不改 run 状态', async () => {
    const coord = getRunCoordinator()
    const snap = coord.startRun({ kind: 'agent', workspaceId: '/ws', sessionId: 's1' })
    coord.markRunning(snap.runId)
    coord.recordToolPhase(snap.runId, 'tc1', 'bash', 'committed')
    coord.commitTerminal({ runId: snap.runId, status: 'interrupted', reason: 'process_exit' })
    const seqBefore = coord.getSnapshot(snap.runId)!.sequence

    const result = await invoke({
      runId: snap.runId,
      action: 'inspect'
    })

    expect(result.ok).toBe(true)
    expect(result.steps).toEqual([
      expect.objectContaining({ toolCallId: 'tc1', toolName: 'bash', phase: 'committed' })
    ])
    expect(coord.getSnapshot(snap.runId)?.sequence).toBe(seqBefore)
  })
})
