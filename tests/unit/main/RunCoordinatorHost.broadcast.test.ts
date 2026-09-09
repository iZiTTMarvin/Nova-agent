import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const host = vi.hoisted(() => ({ tmpUserData: '' }))

vi.mock('electron', () => ({
  app: { getPath: () => host.tmpUserData },
  BrowserWindow: class BrowserWindow {}
}))

import {
  initRunCoordinatorHost,
  resetRunCoordinatorHostForTests,
  getRunCoordinator
} from '../../../src/main/services/RunCoordinatorHost'

describe('RunCoordinatorHost 快照广播合帧', () => {
  let send: ReturnType<typeof vi.fn>
  let destroyedHandler: (() => void) | undefined
  let winDestroyed = false
  let contentsDestroyed = false

  beforeEach(() => {
    vi.useFakeTimers()
    host.tmpUserData = mkdtempSync(join(tmpdir(), 'nova-run-broadcast-'))
    send = vi.fn()
    destroyedHandler = undefined
    winDestroyed = false
    contentsDestroyed = false
    resetRunCoordinatorHostForTests()
    const fakeWin = {
      isDestroyed: () => winDestroyed,
      once: (_event: string, cb: () => void) => {
        void cb
      },
      webContents: {
        isDestroyed: () => contentsDestroyed,
        send,
        once: (event: string, cb: () => void) => {
          if (event === 'destroyed') destroyedHandler = cb
        }
      }
    }
    initRunCoordinatorHost(() => fakeWin as never)
  })

  afterEach(() => {
    resetRunCoordinatorHostForTests()
    vi.useRealTimers()
    rmSync(host.tmpUserData, { recursive: true, force: true })
  })

  it('工具中间态 50ms 合帧只发最新快照；交互立即发出', () => {
    const coord = getRunCoordinator()
    const snap = coord.startRun({ kind: 'agent', workspaceId: '/ws', sessionId: 's1' })
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0]?.[1].event.type).toBe('run_started')

    coord.heartbeat(snap.runId, { label: 'one' })
    coord.heartbeat(snap.runId, { label: 'two' })
    expect(send).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(50)
    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls[1]?.[1].event).toMatchObject({ type: 'heartbeat' })
    expect(send.mock.calls[1]?.[1].snapshot.progress?.label).toBe('two')

    coord.inbox.enqueue({
      runId: snap.runId,
      sessionId: 's1',
      messageId: 'm1',
      type: 'permission',
      interactionId: 'ask_1',
      payload: { requestId: 'ask_1', toolName: 'bash' }
    })
    expect(send.mock.calls.at(-1)?.[1].event.type).toBe('interaction_enqueued')
  })

  it('webContents 销毁时取消合帧，不再发送', () => {
    const coord = getRunCoordinator()
    const snap = coord.startRun({ kind: 'agent', workspaceId: '/ws', sessionId: 's1' })
    send.mockClear()
    coord.heartbeat(snap.runId, { label: 'pending' })
    contentsDestroyed = true
    winDestroyed = true
    destroyedHandler?.()
    vi.advanceTimersByTime(50)
    expect(send).not.toHaveBeenCalled()
  })
})
