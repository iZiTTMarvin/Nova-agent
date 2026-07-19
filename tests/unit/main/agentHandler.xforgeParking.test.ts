import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CANCEL_EXECUTION } from '../../../src/shared/ipc/channels'

const handlers = vi.hoisted(() => new Map<string, (...args: any[]) => unknown>())
const snapshots = vi.hoisted(() => new Map<string, any>())
const coordinator = vi.hoisted(() => ({
  onTerminalHook: vi.fn(),
  listActiveRuns: vi.fn(() => [] as any[]),
  getSnapshot: vi.fn((runId: string) => snapshots.get(runId) ?? null),
  beginCancel: vi.fn(),
  commitTerminal: vi.fn(),
  inbox: { cancelAllForRun: vi.fn() }
}))
const xforgeService = vi.hoisted(() => ({
  cancelParkedXForgeRun: vi.fn((runId: string) => {
    const current = snapshots.get(runId)
    if (current) {
      snapshots.set(runId, {
        ...current,
        status: 'cancelled',
        xforge: { ...current.xforge, currentStage: 'cancelled' }
      })
    }
    return { ok: true, xforge: snapshots.get(runId)?.xforge }
  })
}))
const executionRegistry = vi.hoisted(() => ({
  hasUnsettledHandle: vi.fn(() => false),
  get: vi.fn(() => null),
  abort: vi.fn(async () => ({ settled: true, lingering: false, generation: null }))
}))

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp') },
  BrowserWindow: class BrowserWindow {},
  protocol: { registerSchemesAsPrivileged: vi.fn() }
}))

vi.mock('../../../src/main/ipc/sessionHandler', () => ({
  getSessionStore: vi.fn()
}))

vi.mock('../../../src/main/services/WorkspaceService', () => ({
  getWorkspaceService: vi.fn()
}))

vi.mock('../../../src/main/ipc/secureIpc', () => ({
  handle: (channel: string, listener: (...args: any[]) => unknown) => handlers.set(channel, listener)
}))

vi.mock('../../../src/main/services/RunCoordinatorHost', () => ({
  getRunCoordinator: () => coordinator,
  getXForgeRunService: () => xforgeService,
  getRunExecutionRegistry: () => executionRegistry,
  getActiveRunId: () => null,
  setActiveRunId: vi.fn()
}))

import { registerAgentHandler } from '../../../src/main/ipc/agentHandler'
import {
  getActiveTurnSessionId,
  isAgentTurnInProgress
} from '../../../src/main/agent/state'

describe('agentHandler XForge parked run 边界', () => {
  beforeEach(() => {
    handlers.clear()
    snapshots.clear()
    coordinator.listActiveRuns.mockReset().mockReturnValue([])
    coordinator.getSnapshot.mockClear()
    coordinator.beginCancel.mockClear()
    coordinator.commitTerminal.mockClear()
    xforgeService.cancelParkedXForgeRun.mockClear()
    coordinator.inbox.cancelAllForRun.mockClear()
    executionRegistry.hasUnsettledHandle.mockReset().mockReturnValue(false)
    executionRegistry.get.mockReset().mockReturnValue(null)
    executionRegistry.abort.mockClear()
  })

  it('parked waiting_user 不再被视为执行中，但真实执行或未收敛句柄仍会阻塞', () => {
    coordinator.listActiveRuns.mockReturnValue([{
      runId: 'parked', kind: 'xforge', sessionId: 'waiting-session', status: 'waiting_user'
    }])

    expect(isAgentTurnInProgress()).toBe(false)
    expect(getActiveTurnSessionId()).toBeNull()

    coordinator.listActiveRuns.mockReturnValue([{
      runId: 'running', kind: 'xforge', sessionId: 'running-session', status: 'running'
    }])
    expect(isAgentTurnInProgress()).toBe(true)
    expect(getActiveTurnSessionId()).toBe('running-session')

    coordinator.listActiveRuns.mockReturnValue([])
    executionRegistry.hasUnsettledHandle.mockReturnValue(true)
    expect(isAgentTurnInProgress()).toBe(true)
  })

  it('指定 parked runId 只取消该 XForge，不调用其他运行的执行句柄', async () => {
    snapshots.set('parked', {
      runId: 'parked',
      kind: 'xforge',
      status: 'waiting_user',
      xforge: { currentStage: 'waiting_user' }
    })
    snapshots.set('other-running', {
      runId: 'other-running',
      kind: 'agent',
      status: 'running'
    })

    registerAgentHandler(() => null, () => null, () => ({} as any))
    const handler = handlers.get(CANCEL_EXECUTION)
    expect(handler).toBeDefined()

    const result = await handler!({} as any, { runId: 'parked' }) as { runId: string; status: string }

    expect(coordinator.beginCancel).toHaveBeenCalledWith('parked')
    expect(coordinator.inbox.cancelAllForRun).toHaveBeenCalledWith('parked')
    expect(xforgeService.cancelParkedXForgeRun).toHaveBeenCalledWith(
      'parked',
      '用户取消已暂停的 XForge 运行'
    )
    expect(executionRegistry.abort).not.toHaveBeenCalled()
    expect(snapshots.get('other-running').status).toBe('running')
    expect(result).toEqual({ runId: 'parked', status: 'cancelled' })
  })
})
