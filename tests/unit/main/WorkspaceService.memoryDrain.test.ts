/**
 * WorkspaceService — 记忆 drain 生命周期（flush-then-delete 顺序）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { SessionStore } from '../../../src/runtime/sessions/SessionStore'
import { WorkspaceService } from '../../../src/main/services/WorkspaceService'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/nova-test-userdata') },
  dialog: { showOpenDialog: vi.fn() },
  BrowserWindow: class {}
}))

vi.mock('../../../src/runtime/agent', () => ({
  calculateContextBreakdown: () => ({ payload: {} })
}))

vi.mock('../../../src/main/agent/state', () => ({
  getMainReadState: () => ({ clear: vi.fn() }),
  isAgentTurnInProgress: vi.fn(() => false),
  getActiveTurnSessionId: vi.fn(() => null)
}))

vi.mock('../../../src/main/index', () => ({
  setCurrentProjectPath: vi.fn(),
  setCurrentMode: vi.fn()
}))

vi.mock('../../../src/main/services/SkillServiceHost', () => ({
  getSkillService: () => ({
    getWorkspaceRoot: () => '/ws',
    load: vi.fn(),
    getRegistry: () => ({ listForContext: () => [] })
  })
}))

vi.mock('../../../src/runtime/model/config', () => ({
  loadModelConfig: () => null
}))

describe('WorkspaceService 记忆 drain 生命周期', () => {
  let tmpDir: string
  let store: SessionStore

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-ws-mem-'))
    store = new SessionStore(tmpDir)
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('deleteSession：flush-then-delete，回调时会话仍在 store', () => {
    const events: string[] = []
    const session = store.create('/ws/project-a', 'default')

    const service = new WorkspaceService({
      getSessionStore: () => store,
      getMainWindow: () => null,
      onSessionLeaving: (sessionId, workspaceRoot) => {
        events.push('leaving')
        expect(sessionId).toBe(session.id)
        expect(workspaceRoot).toBe('/ws/project-a')
        expect(store.load(sessionId)).not.toBeNull()
      },
      onSessionCaptureCleanup: (sessionId) => {
        events.push('cleanup')
        expect(store.load(sessionId)).not.toBeNull()
      }
    })
    service.setBroadcaster(() => {})

    service.selectSession(session.id)
    service.deleteSession(session.id)

    expect(events).toEqual(['leaving', 'cleanup'])
    expect(store.load(session.id)).toBeNull()
  })

  it('selectSession 切走：对旧会话先 leaving 再 cleanup', () => {
    const leftSessions: string[] = []
    const a = store.create('/ws/a', 'default')
    const b = store.create('/ws/b', 'default')

    const service = new WorkspaceService({
      getSessionStore: () => store,
      getMainWindow: () => null,
      onSessionLeaving: (sessionId) => {
        leftSessions.push(sessionId)
      },
      onSessionCaptureCleanup: (sessionId) => {
        leftSessions.push(`cleanup:${sessionId}`)
      }
    })
    service.setBroadcaster(() => {})

    service.selectSession(a.id)
    service.selectSession(b.id)

    expect(leftSessions).toEqual([a.id, `cleanup:${a.id}`])
  })
})
