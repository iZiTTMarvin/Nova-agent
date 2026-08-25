import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceService } from '../../../src/main/services/WorkspaceService'
import { SessionStore } from '../../../src/runtime/sessions/SessionStore'
import type { CreateChildSessionCommand } from '../../../src/runtime/sessions/types'

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
    fs.rmSync(tempRoot, { recursive: true, force: true })
  })

  function createChild(parentSessionId: string, suffix: string) {
    const command: CreateChildSessionCommand = {
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

  function createService() {
    const assertNoNonTerminalRunsForSessions = vi.fn()
    const deleteRunsForSessions = vi.fn(() => 0)
    const service = new WorkspaceService({
      getSessionStore: () => store,
      getMainWindow: () => null,
      getRunCoordinator: () => ({
        assertNoNonTerminalRunsForSessions,
        deleteRunsForSessions
      })
    })
    service.setBroadcaster(() => {})
    return { service, assertNoNonTerminalRunsForSessions, deleteRunsForSessions }
  }

  it('删除父会话时按后序回收明确 child subtree 与对应 run', async () => {
    const parent = store.create(path.join(tempRoot, 'workspace'))
    const child = createChild(parent.id, 'one')
    const { service, assertNoNonTerminalRunsForSessions, deleteRunsForSessions } = createService()
    service.selectSession(child.id)

    await service.deleteSession(parent.id)

    expect(store.load(parent.id)).toBeNull()
    expect(store.load(child.id)).toBeNull()
    expect(assertNoNonTerminalRunsForSessions).toHaveBeenCalledWith(
      new Set([child.id, parent.id])
    )
    expect(deleteRunsForSessions).toHaveBeenCalledWith(new Set([child.id, parent.id]))
    expect(service.getState().currentSessionId).toBeNull()
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
