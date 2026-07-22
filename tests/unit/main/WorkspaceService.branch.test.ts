import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { SessionStore } from '../../../src/runtime/sessions/SessionStore'
import { WorkspaceService } from '../../../src/main/services/WorkspaceService'
import { isAgentTurnInProgress } from '../../../src/main/agent/state'
import {
  writeManifest,
  getFilesDir,
  getForwardDir
} from '../../../src/runtime/checkpoints/manifest'

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

/**
 * WorkspaceService 分叉/Tier 2 单测。
 */
describe('WorkspaceService switchBranch / Tier 2', () => {
  let tmpDir: string
  let store: SessionStore
  let service: WorkspaceService
  let broadcasted: Array<ReturnType<WorkspaceService['getState']>>

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-ws-test-'))
    store = new SessionStore(tmpDir)
    broadcasted = []
    vi.mocked(isAgentTurnInProgress).mockReturnValue(false)

    service = new WorkspaceService({
      getSessionStore: () => store,
      getMainWindow: () => null
    })
    service.setBroadcaster((state) => {
      broadcasted.push(state)
    })
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('switchBranch 应设置 tier1BranchContext 并递增 messagesRevision', () => {
    const session = store.create('/ws', 'default')

    store.appendMessage(session.id, {
      id: 'u1',
      role: 'user',
      content: 'hello',
      timestamp: 1
    })
    store.appendMessage(session.id, {
      id: 'a1',
      role: 'assistant',
      content: 'hi',
      timestamp: 2
    })

    // 第二根用户分支：倒回 null 后 append
    store.setCurrentLeaf(session.id, null)
    store.appendMessage(session.id, {
      id: 'u2',
      role: 'user',
      content: 'hello again',
      timestamp: 3
    })
    store.appendMessage(session.id, {
      id: 'a2',
      role: 'assistant',
      content: 'hi2',
      timestamp: 4
    })

    service['state'] = {
      currentSessionId: session.id,
      currentProjectPath: '/ws',
      currentMode: 'default',
      availableSessions: store.list()
    }

    const result = service.switchBranch({
      sessionId: session.id,
      targetMessageId: 'u1'
    })

    expect(result.messagesRevision).toBe(1)
    // 无 checkpoint 时 Tier 2 全额重放成功，不展示 Tier 1 横幅
    expect(result.tier1BranchContext).toBeNull()
    expect(broadcasted.length).toBeGreaterThan(0)
    expect(broadcasted[broadcasted.length - 1]?.tier1BranchContext).toBeNull()

    const reloaded = store.load(session.id)
    expect(reloaded?.currentLeafId).toBe('a1')
  })

  it('switchBranch Tier 2 应重放目标分支 forward 快照到工作区', () => {
    const wsRoot = path.join(tmpDir, 'project')
    fs.mkdirSync(wsRoot, { recursive: true })
    fs.writeFileSync(path.join(wsRoot, 'f.txt'), 'branch-b', 'utf8')

    const session = store.create(wsRoot, 'default')
    const checkpointRoot = store.getSessionsDir()

    store.appendMessage(session.id, { id: 'u1', role: 'user', content: 'q1', timestamp: 1 })
    store.appendMessage(session.id, { id: 'a1', role: 'assistant', content: 'a1', timestamp: 2 })

    writeManifest(checkpointRoot, {
      sessionId: session.id,
      messageId: 'a1',
      workspaceRoot: wsRoot,
      createdFiles: [],
      modifiedFiles: ['f.txt'],
      deletedFiles: [],
      status: 'active',
      createdAt: 10,
      forwardCaptured: true
    })
    const a1Files = getFilesDir(checkpointRoot, session.id, 'a1')
    const a1Forward = getForwardDir(checkpointRoot, session.id, 'a1')
    fs.mkdirSync(a1Files, { recursive: true })
    fs.mkdirSync(a1Forward, { recursive: true })
    fs.writeFileSync(path.join(a1Files, 'f.txt'), 'base', 'utf8')
    fs.writeFileSync(path.join(a1Forward, 'f.txt'), 'branch-a', 'utf8')

    store.setCurrentLeaf(session.id, null)
    store.appendMessage(session.id, { id: 'u2', role: 'user', content: 'q2', timestamp: 3 })
    store.appendMessage(session.id, { id: 'a2', role: 'assistant', content: 'a2', timestamp: 4 })

    writeManifest(checkpointRoot, {
      sessionId: session.id,
      messageId: 'a2',
      workspaceRoot: wsRoot,
      createdFiles: [],
      modifiedFiles: ['f.txt'],
      deletedFiles: [],
      status: 'active',
      createdAt: 20,
      forwardCaptured: true
    })
    const a2Files = getFilesDir(checkpointRoot, session.id, 'a2')
    const a2Forward = getForwardDir(checkpointRoot, session.id, 'a2')
    fs.mkdirSync(a2Files, { recursive: true })
    fs.mkdirSync(a2Forward, { recursive: true })
    fs.writeFileSync(path.join(a2Files, 'f.txt'), 'base', 'utf8')
    fs.writeFileSync(path.join(a2Forward, 'f.txt'), 'branch-b', 'utf8')

    service['state'] = {
      currentSessionId: session.id,
      currentProjectPath: wsRoot,
      currentMode: 'default',
      availableSessions: store.list()
    }

    const result = service.switchBranch({
      sessionId: session.id,
      targetMessageId: 'u1'
    })

    expect(result.tier1BranchContext).toBeNull()
    expect(fs.readFileSync(path.join(wsRoot, 'f.txt'), 'utf8')).toBe('branch-a')
  })

  it('缺少 forward 快照时 switchBranch 应降级 Tier 1 灰显', () => {
    const wsRoot = path.join(tmpDir, 'project2')
    fs.mkdirSync(wsRoot, { recursive: true })
    fs.writeFileSync(path.join(wsRoot, 'f.txt'), 'branch-b', 'utf8')

    const session = store.create(wsRoot, 'default')
    const checkpointRoot = store.getSessionsDir()

    store.appendMessage(session.id, { id: 'u1', role: 'user', content: 'q1', timestamp: 1 })
    store.appendMessage(session.id, { id: 'a1', role: 'assistant', content: 'a1', timestamp: 2 })

    writeManifest(checkpointRoot, {
      sessionId: session.id,
      messageId: 'a1',
      workspaceRoot: wsRoot,
      createdFiles: [],
      modifiedFiles: ['f.txt'],
      deletedFiles: [],
      status: 'active',
      createdAt: 10
    })
    const a1Files = getFilesDir(checkpointRoot, session.id, 'a1')
    fs.mkdirSync(a1Files, { recursive: true })
    fs.writeFileSync(path.join(a1Files, 'f.txt'), 'base', 'utf8')

    store.setCurrentLeaf(session.id, null)
    store.appendMessage(session.id, { id: 'u2', role: 'user', content: 'q2', timestamp: 3 })
    store.appendMessage(session.id, { id: 'a2', role: 'assistant', content: 'a2', timestamp: 4 })

    writeManifest(checkpointRoot, {
      sessionId: session.id,
      messageId: 'a2',
      workspaceRoot: wsRoot,
      createdFiles: [],
      modifiedFiles: ['f.txt'],
      deletedFiles: [],
      status: 'active',
      createdAt: 20
    })
    const a2Files = getFilesDir(checkpointRoot, session.id, 'a2')
    fs.mkdirSync(a2Files, { recursive: true })
    fs.writeFileSync(path.join(a2Files, 'f.txt'), 'base', 'utf8')

    service['state'] = {
      currentSessionId: session.id,
      currentProjectPath: wsRoot,
      currentMode: 'default',
      availableSessions: store.list()
    }

    const result = service.switchBranch({
      sessionId: session.id,
      targetMessageId: 'u1'
    })

    expect(result.tier1BranchContext?.staleDiffMessageIds).toContain('a1')
    expect(result.tier1BranchContext?.partialReplay).toBe(false)
    expect(fs.readFileSync(path.join(wsRoot, 'f.txt'), 'utf8')).toBe('base')
  })

  it('生成中应拒绝分叉准备操作', () => {
    vi.mocked(isAgentTurnInProgress).mockReturnValue(true)

    const session = store.create('/ws', 'default')
    store.appendMessage(session.id, {
      id: 'u1',
      role: 'user',
      content: 'x',
      timestamp: 1
    })

    service['state'] = {
      currentSessionId: session.id,
      currentProjectPath: '/ws',
      currentMode: 'default',
      availableSessions: store.list()
    }

    expect(() =>
      service.prepareEditResend({ sessionId: session.id, messageId: 'u1' })
    ).toThrow('生成中，请先停止当前回复')
  })
})
