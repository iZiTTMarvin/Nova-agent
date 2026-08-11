import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { SessionStore } from '../../../src/runtime/sessions/SessionStore'
import { WorkspaceService } from '../../../src/main/services/WorkspaceService'
import type { WorkspaceState } from '../../../src/shared/workspace/types'

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
    getWorkspaceRoot: () => null,
    load: vi.fn(),
    getRegistry: () => ({ listForContext: () => [] })
  })
}))

vi.mock('../../../src/runtime/model/config', () => ({
  loadModelConfig: () => null
}))

describe('WorkspaceService setSessionPinned', () => {
  let root: string
  let workspace: string
  let store: SessionStore
  let service: WorkspaceService
  let broadcasted: WorkspaceState[]

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-pin-session-'))
    workspace = path.join(root, 'workspace')
    fs.mkdirSync(workspace)
    store = new SessionStore(path.join(root, 'app-data'))
    service = new WorkspaceService({
      getSessionStore: () => store,
      getMainWindow: () => null
    })
    broadcasted = []
    service.setBroadcaster((state) => {
      broadcasted.push(state)
    })
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('置顶持久化并随广播更新 availableSessions', () => {
    const session = store.create(workspace, 'default')

    const state = service.setSessionPinned({ sessionId: session.id, pinned: true })

    expect(store.load(session.id)?.pinned).toBe(true)
    expect(state.availableSessions.find(s => s.id === session.id)?.pinned).toBe(true)
    expect(broadcasted).toHaveLength(1)
    expect(broadcasted[0].availableSessions.find(s => s.id === session.id)?.pinned).toBe(true)
  })

  it('取消置顶后广播的列表不再携带 pinned', () => {
    const session = store.create(workspace, 'default')
    service.setSessionPinned({ sessionId: session.id, pinned: true })

    const state = service.setSessionPinned({ sessionId: session.id, pinned: false })

    expect(store.load(session.id)?.pinned).toBe(false)
    expect(state.availableSessions.find(s => s.id === session.id)?.pinned).toBeUndefined()
  })
})
