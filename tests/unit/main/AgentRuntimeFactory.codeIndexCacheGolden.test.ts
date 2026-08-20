import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { prepareAgentRuntime } from '../../../src/main/agent/runtime/AgentRuntimeFactory'
import { agentRoute } from '../../../src/runtime/agent/turn'
import { computeWireSnapshot } from '../../../src/runtime/model/requestFingerprint'
import { createRunCoordinator } from '../../../src/runtime/run'
import { SessionStore } from '../../../src/runtime/sessions'
import { DEFAULT_NOVA_SETTINGS } from '../../../src/runtime/settings/novaSettings'
import { ImageStore } from '../../../src/runtime/storage/ImageStore'
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

vi.mock('../../../src/main/services/SkillServiceHost', () => ({
  getSkillService: () => ({
    getWorkspaceRoot: () => '/nova-code-graph-cache-golden',
    load: vi.fn(),
    getRegistry: () => ({
      listForContext: () => [],
      get: () => undefined,
      list: () => []
    })
  })
}))

vi.mock('../../../src/main/services/WorkspaceService', () => ({
  getWorkspaceService: () => ({
    setMode: vi.fn(),
    refreshAvailableSessions: vi.fn()
  })
}))

vi.mock('../../../src/main/services/SubagentSchedulerHost', () => ({
  getSubagentScheduler: () => ({ enqueue: vi.fn() })
}))

describe('AgentRuntimeFactory feature-off cache golden', () => {
  const roots: string[] = []

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('保持改动前的工具面和首条 system message 字节基线', async () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'nova-code-graph-cache-golden-'))
    roots.push(sessionsDir)
    const workspaceRoot = '/nova-code-graph-cache-golden'
    const store = new SessionStore(sessionsDir)
    const session = store.create(workspaceRoot)
    const modelClient = new MockModelClient().addResponse({
      events: [{ type: 'message_end', finishReason: 'stop' }]
    })
    const prepared = prepareAgentRuntime({
      session,
      sessionStore: store,
      sessionId: session.id,
      projectPath: workspaceRoot,
      sessionsDir,
      novaSettings: DEFAULT_NOVA_SETTINGS,
      modelClient,
      getImageStore: () => new ImageStore(sessionsDir),
      readState: createReadState(),
      pendingAskQuestions: new Map(),
      runCoordinator: createRunCoordinator(join(sessionsDir, 'runs'))
    })

    try {
      await prepared.agentLoop.sendMessage('cache golden', agentRoute())
      const call = modelClient.getCalls().at(-1)
      if (!call) throw new Error('模型请求未发生')

      const tools = (call.tools ?? []).map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters
        }
      }))
      const snapshot = computeWireSnapshot(
        { model: 'cache-golden', messages: call.messages, tools },
        'generic'
      )

      expect({
        toolsHash: snapshot.toolsHash,
        systemContentHash: snapshot.messages[0]?.content
      }).toEqual({
        toolsHash: '2aea83e7acbb4a65',
        systemContentHash: '613ccd91d6820acc'
      })
    } finally {
      prepared.agentLoop.dispose()
    }
  })
})
