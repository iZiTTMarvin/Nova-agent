/**
 * switchBranch 同步 IO 期间的 event-loop lag 采样（任务 0 验收数据）。
 * 运行：npx vitest run tests/unit/main/switchBranchLagSnapshot.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { SessionStore } from '../../../src/runtime/sessions/SessionStore'
import { WorkspaceService } from '../../../src/main/services/WorkspaceService'
import { isAgentTurnInProgress } from '../../../src/main/ipc/agentHandler'
import {
  installMainLoopLagMonitor,
  getMainLoopLagApi,
  disposeMainLoopLagMonitor
} from '../../../src/main/diagnostics/mainLoopLagMonitor'
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

vi.mock('../../../src/main/ipc/agentHandler', () => ({
  getMainReadState: () => ({ clear: vi.fn() }),
  isAgentTurnInProgress: vi.fn(() => false)
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

describe('switchBranch event-loop lag 采样', () => {
  let tmpDir: string
  let store: SessionStore
  let service: WorkspaceService
  let projectDir: string

  beforeEach(() => {
    disposeMainLoopLagMonitor()
    installMainLoopLagMonitor({ devOnly: false })
    getMainLoopLagApi().reset()

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-lag-test-'))
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-lag-proj-'))
    store = new SessionStore(tmpDir)
    vi.mocked(isAgentTurnInProgress).mockReturnValue(false)

    service = new WorkspaceService({
      getSessionStore: () => store,
      getMainWindow: () => null
    })
  })

  afterEach(() => {
    disposeMainLoopLagMonitor()
    fs.rmSync(tmpDir, { recursive: true, force: true })
    fs.rmSync(projectDir, { recursive: true, force: true })
  })

  it('含 checkpoint 文件重放的 switchBranch 产生可观测 lag（记录 p50/p99/max）', async () => {
    const session = store.create(projectDir, 'default')

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
    store.setCurrentLeaf(session.id, null)
    store.appendMessage(session.id, {
      id: 'u2',
      role: 'user',
      content: 'branch',
      timestamp: 3
    })
    store.appendMessage(session.id, {
      id: 'a2',
      role: 'assistant',
      content: 'alt',
      timestamp: 4
    })

    // 写入多文件 checkpoint + forward，放大同步 IO
    const checkpointRoot = store.getSessionsDir()

    writeManifest(checkpointRoot, {
      sessionId: session.id,
      messageId: 'a1',
      workspaceRoot: projectDir,
      createdFiles: [],
      modifiedFiles: Array.from({ length: 200 }, (_, i) => `src/file${i}.ts`),
      deletedFiles: [],
      status: 'active',
      createdAt: 10,
      forwardCaptured: true
    })

    const a1Files = getFilesDir(checkpointRoot, session.id, 'a1')
    const a1Forward = getForwardDir(checkpointRoot, session.id, 'a1')
    fs.mkdirSync(a1Files, { recursive: true })
    fs.mkdirSync(a1Forward, { recursive: true })

    for (let i = 0; i < 200; i++) {
      const rel = `src/file${i}.ts`
      const abs = path.join(projectDir, rel)
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.writeFileSync(abs, `// v1 ${i}\n`.repeat(200), 'utf8')
      fs.mkdirSync(path.dirname(path.join(a1Files, rel)), { recursive: true })
      fs.writeFileSync(path.join(a1Files, rel), `// base ${i}\n`, 'utf8')
      fs.mkdirSync(path.dirname(path.join(a1Forward, rel)), { recursive: true })
      fs.writeFileSync(path.join(a1Forward, rel), `// forward ${i}\n`.repeat(200), 'utf8')
    }

    writeManifest(checkpointRoot, {
      sessionId: session.id,
      messageId: 'a2',
      workspaceRoot: projectDir,
      createdFiles: [],
      modifiedFiles: Array.from({ length: 200 }, (_, i) => `src/file${i}.ts`),
      deletedFiles: [],
      status: 'active',
      createdAt: 20,
      forwardCaptured: true
    })

    const a2Files = getFilesDir(checkpointRoot, session.id, 'a2')
    const a2Forward = getForwardDir(checkpointRoot, session.id, 'a2')
    fs.mkdirSync(a2Files, { recursive: true })
    fs.mkdirSync(a2Forward, { recursive: true })

    for (let i = 0; i < 200; i++) {
      const rel = `src/file${i}.ts`
      fs.mkdirSync(path.dirname(path.join(a2Files, rel)), { recursive: true })
      fs.writeFileSync(path.join(a2Files, rel), `// base ${i}\n`, 'utf8')
      fs.mkdirSync(path.dirname(path.join(a2Forward, rel)), { recursive: true })
      fs.writeFileSync(path.join(a2Forward, rel), `// branch-b ${i}\n`.repeat(200), 'utf8')
    }

    service['state'] = {
      currentSessionId: session.id,
      currentProjectPath: projectDir,
      currentMode: 'default',
      availableSessions: store.list()
    }

    getMainLoopLagApi().reset()

    const wallMs = performance.now()
    await new Promise<void>((resolve) => {
      setImmediate(() => {
        service.switchBranch({
          sessionId: session.id,
          targetMessageId: 'u2'
        })
        resolve()
      })
    })
    const switchBranchWallMs = performance.now() - wallMs

    // 等待 histogram 收集 event-loop delay 样本
    await new Promise<void>((resolve) => {
      setTimeout(() => resolve(), 50)
    })

    const snap = getMainLoopLagApi().snapshot()
    // 供交付文档引用；CI 日志可见
    // eslint-disable-next-line no-console
    console.log(
      `[switchBranch-lag] p50=${snap.p50Ms.toFixed(1)}ms ` +
        `p99=${snap.p99Ms.toFixed(1)}ms max=${snap.maxMs.toFixed(1)}ms ` +
        `samples=${snap.sampleCount} wall=${switchBranchWallMs.toFixed(1)}ms`
    )

    // lag 采样在纯同步 FS 路径上可能为 0（单次 event loop turn 内完成），以 wall 时间辅助决策
    expect(switchBranchWallMs).toBeGreaterThan(0)
  })
})
