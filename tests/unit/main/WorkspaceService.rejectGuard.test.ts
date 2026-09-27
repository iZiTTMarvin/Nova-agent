import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { SessionStore } from '../../../src/runtime/sessions/SessionStore'
import { WorkspaceService } from '../../../src/main/services/WorkspaceService'
import { isSessionTurnInProgress } from '../../../src/main/agent/state'
import { writerLeaseRegistry } from '../../../src/runtime/workspace'
import {
  writeManifest,
  getFilesDir,
  readManifest
} from '../../../src/runtime/checkpoints/manifest'
import { digestFileBytes } from '../../../src/runtime/checkpoints/fileDigest'

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

vi.mock('../../../src/runtime/model/config', () => ({
  loadModelConfig: () => null,
  loadLlmRegistry: vi.fn(() => null)
}))

/** 拒绝操作的工作区忙碌守卫：同工作区有写入租约或 turn 在跑时禁止恢复。 */
describe('WorkspaceService 拒绝改动忙碌守卫', () => {
  let tmpDir: string
  let workspaceRoot: string
  let store: SessionStore
  let service: WorkspaceService
  let sessionId: string
  const runIds: string[] = []

  async function acquireLease(root: string): Promise<string> {
    const runId = `run-${runIds.length + 1}`
    runIds.push(runId)
    await writerLeaseRegistry.acquire(root, runId)
    return runId
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-reject-guard-'))
    workspaceRoot = path.join(tmpDir, 'workspace')
    fs.mkdirSync(workspaceRoot, { recursive: true })
    store = new SessionStore(tmpDir)
    service = new WorkspaceService({
      disposeIdleLoopForSession: vi.fn(),
      getSessionStore: () => store,
      getMainWindow: () => null
    })
    service.setBroadcaster(vi.fn())
    sessionId = store.create(workspaceRoot).id
    vi.mocked(isSessionTurnInProgress).mockReturnValue(false)
  })

  afterEach(() => {
    for (const runId of runIds) writerLeaseRegistry.release(runId)
    runIds.length = 0
    writerLeaseRegistry.resetForTests()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  /** 准备真实 checkpoint + 工作区文件，返回当前字节摘要 */
  function setupRejectable(): string {
    fs.writeFileSync(path.join(workspaceRoot, 'a.txt'), 'a-after')
    writeManifest(store.getSessionsDir(), {
      sessionId,
      messageId: 'm1',
      workspaceRoot,
      modifiedFiles: ['a.txt'],
      createdFiles: [],
      deletedFiles: [],
      status: 'active',
      createdAt: 1
    })
    const filesDir = getFilesDir(store.getSessionsDir(), sessionId, 'm1')
    fs.mkdirSync(filesDir, { recursive: true })
    fs.writeFileSync(path.join(filesDir, 'a.txt'), 'a-base')
    return digestFileBytes(fs.readFileSync(path.join(workspaceRoot, 'a.txt')))
  }

  it('同工作区有 run 持写租约：拒绝且文件、manifest 均不变', async () => {
    const digest = setupRejectable()
    const manifestPath = path.join(
      store.getSessionsDir(), sessionId, 'm1', 'manifest.json'
    )
    const manifestBefore = fs.readFileSync(manifestPath)
    await acquireLease(workspaceRoot)

    expect(() =>
      service.rejectFile(sessionId, 'm1', 'a.txt', digest)
    ).toThrow('当前工作区还有任务正在运行')
    expect(fs.readFileSync(path.join(workspaceRoot, 'a.txt'), 'utf8')).toBe('a-after')
    expect(fs.readFileSync(manifestPath).equals(manifestBefore)).toBe(true)
  })

  it('同工作区任一会话 turn 在跑：同样拒绝', () => {
    const digest = setupRejectable()
    vi.mocked(isSessionTurnInProgress).mockImplementation(id => id === sessionId)

    expect(() =>
      service.rejectFile(sessionId, 'm1', 'a.txt', digest)
    ).toThrow('当前工作区还有任务正在运行')
    expect(fs.readFileSync(path.join(workspaceRoot, 'a.txt'), 'utf8')).toBe('a-after')
  })

  it('链接路径指向同一工作区时，别名会话的 turn 与写租约都阻断撤销', async () => {
    const digest = setupRejectable()
    const aliasRoot = path.join(tmpDir, 'workspace-alias')
    fs.symlinkSync(workspaceRoot, aliasRoot, process.platform === 'win32' ? 'junction' : 'dir')
    const aliasSessionId = store.create(aliasRoot).id

    vi.mocked(isSessionTurnInProgress).mockImplementation(id => id === aliasSessionId)
    expect(() => service.rejectFile(sessionId, 'm1', 'a.txt', digest)).toThrow('当前工作区还有任务正在运行')

    vi.mocked(isSessionTurnInProgress).mockReturnValue(false)
    await acquireLease(aliasRoot)
    expect(() => service.rejectFile(sessionId, 'm1', 'a.txt', digest)).toThrow('当前工作区还有任务正在运行')
    expect(fs.readFileSync(path.join(workspaceRoot, 'a.txt'), 'utf8')).toBe('a-after')
  })

  it('异工作区持租不阻断：正常恢复', async () => {
    const digest = setupRejectable()
    await acquireLease(path.join(tmpDir, 'other-workspace'))

    service.rejectFile(sessionId, 'm1', 'a.txt', digest)

    expect(fs.readFileSync(path.join(workspaceRoot, 'a.txt'), 'utf8')).toBe('a-base')
    const manifest = readManifest(store.getSessionsDir(), sessionId, 'm1')!
    expect(manifest.fileReviews?.['a.txt']).toBe('rejected')
  })
})
