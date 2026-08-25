import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  WorkspaceService,
  type WorkspaceRootChange
} from '../../../src/main/services/WorkspaceService'
import { SessionStore } from '../../../src/runtime/sessions/SessionStore'

const { loadNovaSettingsMock } = vi.hoisted(() => ({
  loadNovaSettingsMock: vi.fn()
}))

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
  reloadSkillsForWorkspace: vi.fn(),
  getSkillService: () => ({
    getWorkspaceRoot: () => '/workspace',
    load: vi.fn(),
    getRegistry: () => ({ listForContext: () => [] })
  })
}))

vi.mock('../../../src/runtime/model/config', () => ({ loadModelConfig: () => null }))

vi.mock('../../../src/runtime/settings/novaSettings', () => ({
  loadNovaSettings: () => loadNovaSettingsMock()
}))

describe('WorkspaceService workspace root changes', () => {
  let tempRoot: string
  let store: SessionStore

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-workspace-root-change-'))
    store = new SessionStore(tempRoot)
    loadNovaSettingsMock.mockReturnValue({ codeIndexEnabled: false })
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

  it('删除最后一个会话时发送 workspace 关闭通知', async () => {
    const service = createService()
    const events: WorkspaceRootChange[] = []
    const session = store.create('/workspace/a')
    service.subscribeWorkspaceRootChanges((change) => events.push(change))
    service.selectSession(session.id)
    events.length = 0

    await service.deleteSession(session.id)

    expect(events).toEqual([
      { previousRoot: '/workspace/a', nextRoot: null }
    ])
  })

  it('启动恢复、选择项目与显式创建会话都发布根路径变化', async () => {
    const startupSession = store.create('/workspace/startup')
    const startupService = createService()
    const startupEvents: WorkspaceRootChange[] = []
    startupService.subscribeWorkspaceRootChanges((change) => startupEvents.push(change))

    startupService.initOnStartup()

    expect(startupEvents).toEqual([
      { previousRoot: null, nextRoot: startupSession.workspaceRoot }
    ])

    await startupService.selectProject({ path: '/workspace/selected' })
    startupService.createSession({ workspaceRoot: '/workspace/created' })

    expect(startupEvents).toEqual([
      { previousRoot: null, nextRoot: startupSession.workspaceRoot },
      { previousRoot: startupSession.workspaceRoot, nextRoot: '/workspace/selected' },
      { previousRoot: '/workspace/selected', nextRoot: '/workspace/created' }
    ])
  })

  it('设置开关只在创建新会话时写入工具面快照', () => {
    const service = createService()
    service.createSession({ workspaceRoot: '/workspace/disabled' })
    const disabledId = service.getState().currentSessionId

    loadNovaSettingsMock.mockReturnValue({ codeIndexEnabled: true })
    service.createSession({ workspaceRoot: '/workspace/enabled' })
    const enabledId = service.getState().currentSessionId

    if (!disabledId || !enabledId) throw new Error('会话创建失败')
    expect(store.load(disabledId)?.codeIndexEnabled).toBe(false)
    expect(store.load(enabledId)?.codeIndexEnabled).toBe(true)
    expect(store.load(disabledId)?.codeIndexEnabled).toBe(false)
  })

  it('删除当前会话并切到不同项目时发布前后根路径', async () => {
    const service = createService()
    const events: WorkspaceRootChange[] = []
    const current = store.create('/workspace/current')
    const remaining = store.create('/workspace/remaining')
    service.subscribeWorkspaceRootChanges((change) => events.push(change))
    service.selectSession(current.id)
    events.length = 0

    await service.deleteSession(current.id)

    expect(service.getState().currentSessionId).toBe(remaining.id)
    expect(events).toEqual([
      { previousRoot: '/workspace/current', nextRoot: '/workspace/remaining' }
    ])
  })

  it('冻结事件且单个订阅者失败不阻止其余订阅者', async () => {
    const service = createService()
    const listenerError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const survivingEvents: WorkspaceRootChange[] = []
    let eventWasFrozen = false
    service.subscribeWorkspaceRootChanges((change) => {
      eventWasFrozen = Object.isFrozen(change)
      throw new Error('listener failed')
    })
    service.subscribeWorkspaceRootChanges(async () => {
      throw new Error('async listener failed')
    })
    service.subscribeWorkspaceRootChanges((change) => survivingEvents.push(change))
    const session = store.create('/workspace/a')

    service.selectSession(session.id)
    await Promise.resolve()

    expect(survivingEvents).toEqual([
      { previousRoot: null, nextRoot: '/workspace/a' }
    ])
    expect(eventWasFrozen).toBe(true)
    expect(listenerError).toHaveBeenCalledTimes(2)
  })
})
