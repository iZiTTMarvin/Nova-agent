import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { SessionStore } from '../../../src/runtime/sessions/SessionStore'
import { WorkspaceService } from '../../../src/main/services/WorkspaceService'
import { isSessionTurnInProgress } from '../../../src/main/agent/state'

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

describe('WorkspaceService mode gate', () => {
  let root: string
  let workspace: string
  let store: SessionStore
  let service: WorkspaceService

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-mode-gate-'))
    workspace = path.join(root, 'workspace')
    fs.mkdirSync(workspace)
    store = new SessionStore(path.join(root, 'app-data'))
    service = new WorkspaceService({
      getSessionStore: () => store,
      getMainWindow: () => null
    })
    vi.mocked(isSessionTurnInProgress).mockReturnValue(false)
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('启动时应把最近会话设为当前事实源并恢复其模式', () => {
    const session = store.create(workspace, 'plan')

    service.initOnStartup()

    expect(service.getState()).toMatchObject({
      currentSessionId: session.id,
      currentProjectPath: workspace,
      currentMode: 'plan'
    })
  })

  it('用户可以在没有 active plan 时手动退出 Plan 模式', () => {
    const session = store.create(workspace, 'plan')

    service.initOnStartup()

    const state = service.setMode({ mode: 'default', sessionId: session.id, source: 'user' })

    expect(state.currentMode).toBe('default')
    expect(store.load(session.id)?.mode).toBe('default')
  })

  it('只返回当前会话登记且仍在工作区边界内的完整 active plan', () => {
    const session = store.create(workspace, 'plan')
    const relativePath = '.nova/plans/2026-07-24-reviewable-plan.md'
    const content = '# 完整计划\n\n' + '实施步骤\n'.repeat(2000)
    fs.mkdirSync(path.join(workspace, '.nova', 'plans'), { recursive: true })
    fs.writeFileSync(path.join(workspace, relativePath), content)
    store.updateActivePlan(session.id, {
      path: relativePath,
      title: 'Reviewable Plan',
      updatedAt: 123
    })

    expect(service.readActivePlan({
      sessionId: session.id,
      expectedPath: relativePath,
      expectedTitle: 'Reviewable Plan'
    })).toEqual({
      path: relativePath,
      title: 'Reviewable Plan',
      updatedAt: 123,
      content
    })
    expect(service.readActivePlan({
      sessionId: session.id,
      expectedPath: '.nova/plans/another-plan.md',
      expectedTitle: 'Reviewable Plan'
    })).toBeNull()
    expect(service.readActivePlan({
      sessionId: session.id,
      expectedTitle: 'Another Plan'
    })).toBeNull()
  })

  it('active plan 被硬链接重定向时拒绝读取正文', () => {
    const session = store.create(workspace, 'plan')
    const relativePath = '.nova/plans/2026-07-24-linked-plan.md'
    const absolutePath = path.join(workspace, relativePath)
    const outside = path.join(root, 'outside.md')
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true })
    fs.writeFileSync(outside, '# outside\n')
    fs.linkSync(outside, absolutePath)
    store.updateActivePlan(session.id, {
      path: relativePath,
      title: 'Linked Plan',
      updatedAt: 123
    })

    expect(service.readActivePlan({ sessionId: session.id })).toBeNull()
  })

  it('用户不能在 turn 运行中切模式，已确认的 agent 切换走受控内部入口', () => {
    const session = store.create(workspace, 'default')
    vi.mocked(isSessionTurnInProgress).mockReturnValue(true)

    expect(() =>
      service.setMode({ mode: 'plan', sessionId: session.id, source: 'user' })
    ).toThrow('当前会话仍在运行')
    expect(store.load(session.id)?.mode).toBe('default')

    service.setMode({ mode: 'plan', sessionId: session.id, source: 'agent' })
    expect(store.load(session.id)?.mode).toBe('plan')
  })
})
