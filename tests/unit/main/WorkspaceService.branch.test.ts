import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { SessionStore } from '../../../src/runtime/sessions/SessionStore'
import { WorkspaceService } from '../../../src/main/services/WorkspaceService'
import { isAgentTurnInProgress } from '../../../src/main/agent/state'
import { createCustomProvider, type LlmRegistry } from '../../../src/shared/config/llmRegistry'
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
  isSessionTurnInProgress: vi.fn(() => false)
}))

vi.mock('../../../src/main/index', () => ({
  setCurrentProjectPath: vi.fn(),
  setCurrentMode: vi.fn()
}))

vi.mock('../../../src/main/services/SkillServiceHost', () => ({
  reloadSkillsForWorkspace: vi.fn(),
  getSkillService: () => ({
    getWorkspaceRoot: () => '/ws',
    load: vi.fn(),
    getRegistry: () => ({ listForContext: () => [] })
  })
}))

const modelConfigMocks = vi.hoisted(() => ({
  loadLlmRegistry: vi.fn()
}))

vi.mock('../../../src/runtime/model/config', () => ({
  loadModelConfig: () => null,
  loadLlmRegistry: modelConfigMocks.loadLlmRegistry
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
    modelConfigMocks.loadLlmRegistry.mockReturnValue(null)

    service = new WorkspaceService({
      disposeIdleLoopForSession: vi.fn(),
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

  it('selectSession 不扫全部会话、不全量读对话记录', () => {
    const first = store.create('/ws')
    const second = store.create('/ws')
    service.initOnStartup()
    expect(service.getState().currentSessionId).toBe(second.id)

    const listSpy = vi.spyOn(store, 'list')
    const loadSpy = vi.spyOn(store, 'load')
    const before = service.getState().availableSessions

    service.selectSession(first.id)

    expect(listSpy).not.toHaveBeenCalled()
    expect(loadSpy).not.toHaveBeenCalled()
    expect(service.getState().availableSessions).toBe(before)
    expect(service.getState().currentSessionId).toBe(first.id)
    expect(service.getState().currentProjectPath).toBe('/ws')
  })

  it('initOnStartup 选中会话不读完整对话记录', () => {
    const session = store.create('/ws')
    store.updateReasoningEffortOverride(session.id, 'high')
    const loadSpy = vi.spyOn(store, 'load')
    service.initOnStartup()
    expect(loadSpy).not.toHaveBeenCalled()
    expect(service.getState().currentSessionId).toBe(session.id)
    expect(service.getState().reasoningEffortOverride).toBe('high')
  })

  it('新会话继承上一会话的模型与思考强度，并且立即广播一致状态', () => {
    const registry = modelRegistry()
    modelConfigMocks.loadLlmRegistry.mockReturnValue(registry)
    const first = store.create('/ws', 'default', {
      modelOverride: { providerId: 'provider', modelEntryId: 'gpt' },
      reasoningEffortOverride: 'xhigh'
    })
    service.initOnStartup()

    const next = service.createSession({ workspaceRoot: '/ws' })
    const persisted = store.loadMetadata(next.currentSessionId!)

    expect(persisted?.modelOverride).toEqual({ providerId: 'provider', modelEntryId: 'gpt' })
    expect(persisted?.reasoningEffortOverride).toBe('xhigh')
    expect(next.activeModelRef).toEqual({ providerId: 'provider', modelEntryId: 'gpt' })
    expect(next.reasoningEffortOverride).toBe('xhigh')
    expect(next.currentSessionId).not.toBe(first.id)
  })

  it('模型切换在主进程对账档位，切回会话恢复各自选择', () => {
    const registry = modelRegistry()
    modelConfigMocks.loadLlmRegistry.mockReturnValue(registry)
    const first = store.create('/ws', 'default', {
      modelOverride: { providerId: 'provider', modelEntryId: 'gpt' },
      reasoningEffortOverride: 'xhigh'
    })
    const second = store.create('/ws', 'default', {
      modelOverride: { providerId: 'provider', modelEntryId: 'gpt' },
      reasoningEffortOverride: 'xhigh'
    })
    service.initOnStartup()
    service.selectSession(second.id)

    const switched = service.setSessionModel({
      ref: { providerId: 'provider', modelEntryId: 'minimax' }
    })
    expect(switched.activeModelRef).toEqual({ providerId: 'provider', modelEntryId: 'minimax' })
    expect(switched.reasoningEffortOverride).toBeNull()
    expect(store.loadMetadata(second.id)?.reasoningEffortOverride).toBeUndefined()

    const restored = service.selectSession(first.id)
    expect(restored.activeModelRef).toEqual({ providerId: 'provider', modelEntryId: 'gpt' })
    expect(restored.reasoningEffortOverride).toBe('xhigh')
    expect(registry.activeModel).toEqual({ providerId: 'provider', modelEntryId: 'gpt' })
  })

  it('拒绝当前模型不支持的思考强度', () => {
    const registry = modelRegistry()
    modelConfigMocks.loadLlmRegistry.mockReturnValue(registry)
    const session = store.create('/ws', 'default', {
      modelOverride: { providerId: 'provider', modelEntryId: 'minimax' },
      reasoningEffortOverride: 'high'
    })
    service.initOnStartup()

    expect(() => service.setReasoningEffortOverride({ effort: 'xhigh' }))
      .toThrow('当前模型不支持思考强度 xhigh')
    expect(store.loadMetadata(session.id)?.reasoningEffortOverride).toBe('high')
  })

  it('切走后不再为过期会话全量计算上下文', async () => {
    const first = store.create('/ws')
    const second = store.create('/ws')
    service.initOnStartup()
    service.selectSession(first.id)

    const loadSpy = vi.spyOn(store, 'load')
    service.scheduleContextBreakdown(first.id)
    service.selectSession(second.id)
    loadSpy.mockClear()

    await new Promise<void>((resolve) => {
      setImmediate(resolve)
    })
    expect(loadSpy).not.toHaveBeenCalled()
  })

  function createTwoBranchSession() {
    const session = store.create('/ws', 'default')
    store.appendMessage(session.id, { id: 'u1', role: 'user', content: 'q1', timestamp: 1 })
    store.appendMessage(session.id, { id: 'a1', role: 'assistant', content: 'a1', timestamp: 2 })
    store.setCurrentLeaf(session.id, null)
    store.appendMessage(session.id, { id: 'u2', role: 'user', content: 'q2', timestamp: 3 })
    store.appendMessage(session.id, { id: 'a2', role: 'assistant', content: 'a2', timestamp: 4 })
    return session
  }

  function modelRegistry(): LlmRegistry {
    const provider = createCustomProvider('Models', 'https://models.example/v1')
    provider.id = 'provider'
    provider.apiKey = 'key'
    provider.models = [
      { id: 'gpt', modelId: 'gpt-5.4', displayName: 'GPT-5.4' },
      { id: 'minimax', modelId: 'MiniMax-M3', displayName: 'MiniMax-M3' }
    ]
    return {
      version: 2,
      providers: [provider],
      activeModel: { providerId: 'provider', modelEntryId: 'gpt' }
    }
  }

  it('switchBranch 先失效化丢弃路径的投递再切 leaf', () => {
    const session = createTwoBranchSession()
    const calls: Array<{ discarded: string[]; leafAtCall: string | null }> = []
    const svc = new WorkspaceService({
      disposeIdleLoopForSession: vi.fn(),
      getSessionStore: () => store,
      getMainWindow: () => null,
      invalidateBranchDelivery: (sessionId, discarded) => {
        calls.push({
          discarded: [...discarded],
          leafAtCall: store.load(sessionId)?.currentLeafId ?? null
        })
      }
    })

    svc.switchBranch({ sessionId: session.id, targetMessageId: 'u1' })

    // 丢弃集合 = 离开激活路径的旧分支节点；调用时 leaf 尚未变更
    expect(calls).toEqual([{ discarded: ['u2', 'a2'], leafAtCall: 'a2' }])
    expect(store.load(session.id)?.currentLeafId).toBe('a1')
  })

  it('失效化失败时不切 leaf 也不回报成功', () => {
    const session = createTwoBranchSession()
    const svc = new WorkspaceService({
      disposeIdleLoopForSession: vi.fn(),
      getSessionStore: () => store,
      getMainWindow: () => null,
      invalidateBranchDelivery: () => {
        throw new Error('意图写盘失败')
      }
    })

    expect(() => svc.switchBranch({ sessionId: session.id, targetMessageId: 'u1' }))
      .toThrow('意图写盘失败')
    expect(store.load(session.id)?.currentLeafId).toBe('a2')
  })

  it('prepareEditResend 失效化覆盖目标消息及其之后', () => {
    const session = createTwoBranchSession()
    const calls: string[][] = []
    const svc = new WorkspaceService({
      disposeIdleLoopForSession: vi.fn(),
      getSessionStore: () => store,
      getMainWindow: () => null,
      invalidateBranchDelivery: (_sessionId, discarded) => {
        calls.push([...discarded])
      }
    })

    svc.prepareEditResend({ sessionId: session.id, messageId: 'u2' })

    expect(calls).toEqual([['u2', 'a2']])
  })
})
