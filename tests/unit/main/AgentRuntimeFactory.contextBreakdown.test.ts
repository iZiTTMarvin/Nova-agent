import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { prepareAgentRuntime } from '../../../src/main/agent/runtime/AgentRuntimeFactory'
import { calculateContextBreakdown } from '../../../src/runtime/agent'
import { SessionStore } from '../../../src/runtime/sessions'
import { DEFAULT_NOVA_SETTINGS } from '../../../src/runtime/settings/novaSettings'
import { createReadState } from '../../../src/runtime/tools/editTool'
import { MockModelClient } from '../../../src/test-support/builders/MockModelClient'

vi.mock('electron', () => ({
  app: {
    getPath: () => tmpdir(),
    getAppPath: () => tmpdir()
  },
  protocol: {
    registerSchemesAsPrivileged: vi.fn()
  },
  BrowserWindow: class BrowserWindow {}
}))

vi.mock('../../../src/main/services/WorkspaceService', () => ({
  getWorkspaceService: () => ({
    setMode: vi.fn(),
    refreshAvailableSessions: vi.fn()
  })
}))

vi.mock('../../../src/main/services/SubagentSchedulerHost', () => ({
  getSubagentScheduler: () => ({
    enqueue: vi.fn()
  })
}))

describe('AgentRuntimeFactory.frozenPrompt 与上下文容量估算', () => {
  const roots: string[] = []

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  it('prepareAgentRuntime 返回完整 frozenPrompt，并支持会话持久化与非零上下文分项估算', () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'nova-factory-context-'))
    roots.push(sessionsDir)
    const workspace = resolve(sessionsDir, 'workspace')
    const store = new SessionStore(sessionsDir)
    const session = store.create(workspace)

    const prepared = prepareAgentRuntime({
      session,
      sessionStore: store,
      sessionId: session.id,
      projectPath: workspace,
      sessionsDir,
      novaSettings: DEFAULT_NOVA_SETTINGS,
      modelClient: new MockModelClient(),
      getImageStore: () => ({} as any),
      readState: createReadState(),
      pendingAskQuestions: new Map(),
      runCoordinator: {
        inbox: { enqueue: vi.fn() },
        getSnapshot: () => null
      } as any
    })

    // 1. 验证 frozenPrompt 包含完整的分层结构，特别是 Available Tools
    expect(prepared.frozenPrompt).toContain('=== Agent Role ===')
    expect(prepared.frozenPrompt).toContain('=== Base Rules ===')
    expect(prepared.frozenPrompt).toContain('=== Available Tools ===')

    // 2. 模拟将 frozenPrompt 持久化到会话
    session.frozenSystemPrompt = prepared.frozenPrompt
    store.save(session)

    // 3. 模拟 pushContextBreakdownForSession 路径（toolDefinitions 传入空数组）
    const { payload } = calculateContextBreakdown({
      session,
      skills: [],
      toolDefinitions: [],
      contextLimit: 200_000
    })

    // 4. 验证 tools 和 systemPrompt 均大于 0，绝对不为 0
    expect(payload.breakdown.tools).toBeGreaterThan(0)
    expect(payload.breakdown.systemPrompt).toBeGreaterThan(0)
    expect(payload.totalEstimated).toBe(
      payload.breakdown.systemPrompt +
      payload.breakdown.skills +
      payload.breakdown.tools +
      payload.breakdown.messages +
      payload.breakdown.other
    )

    prepared.agentLoop.dispose()
  })
})
