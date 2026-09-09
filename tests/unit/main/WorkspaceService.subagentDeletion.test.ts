import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceService } from '../../../src/main/services/WorkspaceService'
import { SessionStore, deriveChildSessionId } from '../../../src/runtime/sessions/SessionStore'
import type { CreateChildSessionCommand } from '../../../src/runtime/sessions/types'
import { RunCoordinator, RunStore } from '../../../src/runtime/run'
import { processRegistry } from '../../../src/runtime/process'
import { EventEmitter } from 'node:events'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/nova-test-userdata') },
  dialog: { showOpenDialog: vi.fn() },
  BrowserWindow: class {}
}))
vi.mock('../../../src/runtime/agent', () => ({
  calculateContextBreakdown: () => ({ payload: {} })
}))
vi.mock('../../../src/main/agent/state', () => ({
  clearReadStateForSession: vi.fn(),
  deleteReadStateForSession: vi.fn(),
  isAgentTurnInProgress: vi.fn(() => false),
  isSessionTurnInProgress: vi.fn(() => false)
}))
vi.mock('../../../src/main/index', () => ({
  setCurrentProjectPath: vi.fn(),
  setCurrentMode: vi.fn()
}))
vi.mock('../../../src/main/services/SkillServiceHost', () => ({
  reloadSkillsForWorkspace: vi.fn(),
  getSkillService: () => ({
    getWorkspaceRoot: () => '/workspace',
    load: vi.fn(),
    getRegistry: () => ({ listForContext: () => [] })
  })
}))
vi.mock('../../../src/runtime/model/config', () => ({ loadModelConfig: () => null }))

describe('WorkspaceService subagent deletion', () => {
  let tempRoot: string
  let store: SessionStore

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-ws-child-delete-'))
    store = new SessionStore(tempRoot)
  })

  afterEach(() => {
    processRegistry.resetForTests()
    vi.restoreAllMocks()
    fs.rmSync(tempRoot, { recursive: true, force: true })
  })

  function createChild(parentSessionId: string, suffix: string) {
    const command: CreateChildSessionCommand = {
      childSessionId: deriveChildSessionId(`spawn-key-${suffix}`),
      workspaceRoot: path.join(tempRoot, 'workspace'),
      mode: 'default',
      permissionMode: 'request_approval',
      task: `child task ${suffix}`,
      subagent: {
        lineage: {
          parentSessionId,
          parentRunId: `parent-run-${suffix}`,
          rootRunId: 'root-run',
          depth: 1,
          spawnKey: `spawn-key-${suffix}`,
          spawnRunId: `spawn-run-${suffix}`,
          origin: {
            kind: 'task_tool',
            parentMessageId: `parent-message-${suffix}`,
            parentToolCallId: `parent-tool-${suffix}`
          }
        },
        profile: {
          profileId: 'explore',
          name: 'Explore',
          description: 'Read-only exploration',
          systemPrompt: 'Inspect carefully',
          toolNames: ['read'],
          permissionCeiling: 'read_only',
          maxToolRounds: 10,
          configHash: 'hash'
        }
      }
    }
    return store.createChildIfAbsent(command).session
  }

  it('最新活动属于子任务时，启动打开所属父会话', () => {
    const parent = store.create(path.join(tempRoot, 'workspace'))
    const child = createChild(parent.id, 'startup')
    store.updateTitle(child.id, '最新子任务', 'manual')
    const { service } = createService()
    service.initOnStartup()
    expect(service.getState().currentSessionId).toBe(parent.id)
    expect(service.getState().availableSessions.some(session => session.id === child.id)).toBe(true)
  })

  function createService() {
    const runStore = new RunStore({ runsRoot: path.join(tempRoot, 'runs') })
    const coordinator = new RunCoordinator({ store: runStore })
    const assertNoNonTerminalRunsForSessions = vi.spyOn(coordinator, 'assertNoNonTerminalRunsForSessions')
    const deleteRunsForSessions = vi.spyOn(coordinator, 'deleteRunsForSessions')
    const idleSessions = new Set(store.listInternal().map(session => session.id))
    const service = new WorkspaceService({
      disposeIdleLoopForSession: sessionId => { idleSessions.delete(sessionId) },
      getSessionStore: () => store,
      getMainWindow: () => null,
      getRunCoordinator: () => coordinator
    })
    service.setBroadcaster(() => {})
    return { service, idleSessions, coordinator, runStore, assertNoNonTerminalRunsForSessions, deleteRunsForSessions }
  }

  it('删除父会话时按后序回收明确 child subtree 与对应 run', async () => {
    const parent = store.create(path.join(tempRoot, 'workspace'))
    const child = createChild(parent.id, 'one')
    const other = store.create(path.join(tempRoot, 'other-workspace'))
    const { service, idleSessions, assertNoNonTerminalRunsForSessions, deleteRunsForSessions } = createService()
    service.selectSession(child.id)

    await service.deleteSession(parent.id)

    expect(store.load(parent.id)).toBeNull()
    expect(store.load(child.id)).toBeNull()
    expect(assertNoNonTerminalRunsForSessions).toHaveBeenCalledWith(
      new Set([child.id, parent.id])
    )
    expect(deleteRunsForSessions).toHaveBeenCalledWith(new Set([child.id, parent.id]))
    expect(service.getState().currentSessionId).toBe(other.id)
    expect(idleSessions).toEqual(new Set([other.id]))
    expect(store.load(other.id)).not.toBeNull()
  })

  it('父树任一进程清理失败时保留全部历史、焦点与 run，重试成功后才删除', async () => {
    const parent = store.create(path.join(tempRoot, 'workspace'))
    const child = createChild(parent.id, 'failure')
    const grandchild = createChild(child.id, 'nested-failure')
    const other = store.create(path.join(tempRoot, 'other-workspace'))
    const { service, coordinator, runStore, idleSessions } = createService()
    const selected = [parent, child, grandchild]
    for (const [index, session] of selected.entries()) {
      coordinator.startRun({ runId: `delete-run-${index}`, kind: 'agent', sessionId: session.id, workspaceId: tempRoot })
      coordinator.commitTerminal({ runId: `delete-run-${index}`, status: 'completed' })
    }
    service.selectSession(grandchild.id)
    const beforeState = service.getState()
    const beforeSessions = selected.map(session => store.load(session.id))
    const beforeRuns = selected.map((_, index) => runStore.loadSnapshot(`delete-run-${index}`))
    const beforeIdle = new Set(idleSessions)
    let fail = true
    const childProcess = Object.assign(new EventEmitter(), { exitCode: null as number | null, signalCode: null })
    processRegistry.register({
      owner: { sessionId: parent.id, runId: 'delete-run-0' }, source: 'main-run',
      command: 'persistent', workdir: tempRoot, destructive: false, seedOutput: '', checkpointBaseline: null,
      child: childProcess, writeStdin: async () => {},
      killTree: async () => {
        if (fail) throw new Error('descendant denied')
        childProcess.exitCode = 0
        childProcess.emit('close')
      }
    })
    await expect(service.deleteSession(parent.id)).rejects.toThrow('未删除会话')
    expect(selected.map(session => store.load(session.id))).toEqual(beforeSessions)
    expect(service.getState()).toEqual(beforeState)
    expect(selected.map((_, index) => runStore.loadSnapshot(`delete-run-${index}`))).toEqual(beforeRuns)
    expect(idleSessions).toEqual(beforeIdle)
    fail = false
    await service.deleteSession(parent.id)
    expect(selected.map(session => store.load(session.id))).toEqual([null, null, null])
    expect(selected.map((_, index) => coordinator.getSnapshot(`delete-run-${index}`))).toEqual([null, null, null])
    expect(service.getState().currentSessionId).toBe(other.id)
  })

  it('禁止绕过父会话单独删除 Child Session', async () => {
    const parent = store.create(path.join(tempRoot, 'workspace'))
    const child = createChild(parent.id, 'one')
    const { service } = createService()

    await expect(service.deleteSession(child.id)).rejects.toThrow(/Child Session 不允许单独删除/)
    expect(store.load(parent.id)).not.toBeNull()
    expect(store.load(child.id)).not.toBeNull()
  })
})
