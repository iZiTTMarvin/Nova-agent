import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  WorkspaceService,
  type WorkspaceRootChange
} from '../../../src/main/services/WorkspaceService'
import { SessionStore } from '../../../src/runtime/sessions/SessionStore'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/nova-test-userdata') },
  dialog: { showOpenDialog: vi.fn() },
  BrowserWindow: class BrowserWindow {}
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

describe('WorkspaceService workspace root changes', () => {
  let tempRoot: string
  let store: SessionStore

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-workspace-root-change-'))
    store = new SessionStore(tempRoot)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    fs.rmSync(tempRoot, { recursive: true, force: true })
  })

  function createService(): WorkspaceService {
    const service = new WorkspaceService({
      getSessionStore: () => store,
      getMainWindow: () => null,
      getRunCoordinator: () => ({
        assertNoNonTerminalRunsForSessions: vi.fn(),
        deleteRunsForSessions: vi.fn(() => 0)
      })
    })
    service.setBroadcaster(() => {})
    return service
  }

  it('向多个订阅者发送 previousRoot 与 nextRoot，并忽略同根会话切换', () => {
    const service = createService()
    const firstEvents: WorkspaceRootChange[] = []
    const secondEvents: WorkspaceRootChange[] = []
    service.subscribeWorkspaceRootChanges((change) => firstEvents.push(change))
    const unsubscribeSecond = service.subscribeWorkspaceRootChanges((change) => {
      secondEvents.push(change)
    })
    const firstSession = store.create('/workspace/a')
    const sameRootSession = store.create('/workspace/a')
    const nextSession = store.create('/workspace/b')

    service.selectSession(firstSession.id)
    service.selectSession(sameRootSession.id)
    unsubscribeSecond()
    service.selectSession(nextSession.id)

    expect(firstEvents).toEqual([
      { previousRoot: null, nextRoot: '/workspace/a' },
      { previousRoot: '/workspace/a', nextRoot: '/workspace/b' }
    ])
    expect(secondEvents).toEqual([
      { previousRoot: null, nextRoot: '/workspace/a' }
    ])
  })

  it('删除最后一个会话时发送 workspace 关闭通知', () => {
    const service = createService()
    const events: WorkspaceRootChange[] = []
    const session = store.create('/workspace/a')
    service.subscribeWorkspaceRootChanges((change) => events.push(change))
    service.selectSession(session.id)
    events.length = 0

    service.deleteSession(session.id)

    expect(events).toEqual([
      { previousRoot: '/workspace/a', nextRoot: null }
    ])
  })

  it('单个订阅者失败不阻止其余订阅者收到事件', () => {
    const service = createService()
    const listenerError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const survivingEvents: WorkspaceRootChange[] = []
    service.subscribeWorkspaceRootChanges(() => {
      throw new Error('listener failed')
    })
    service.subscribeWorkspaceRootChanges((change) => survivingEvents.push(change))
    const session = store.create('/workspace/a')

    service.selectSession(session.id)

    expect(survivingEvents).toEqual([
      { previousRoot: null, nextRoot: '/workspace/a' }
    ])
    expect(listenerError).toHaveBeenCalledOnce()
  })
})
