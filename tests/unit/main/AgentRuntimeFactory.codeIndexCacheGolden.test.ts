import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { prepareAgentRuntime } from '../../../src/main/agent/runtime/AgentRuntimeFactory'
import { agentRoute } from '../../../src/runtime/agent/turn'
import { OpenAICompatibleModelClient } from '../../../src/runtime/model/OpenAICompatibleModelClient'
import { computeWireSnapshot } from '../../../src/runtime/model/requestFingerprint'
import { createRunCoordinator } from '../../../src/runtime/run'
import { SessionStore } from '../../../src/runtime/sessions'
import { DEFAULT_NOVA_SETTINGS } from '../../../src/runtime/settings/novaSettings'
import { ImageStore } from '../../../src/runtime/storage/ImageStore'
import { createReadState } from '../../../src/runtime/tools/editTool'

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

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
    let wireBody: Record<string, unknown> | null = null
    const modelClient = new OpenAICompatibleModelClient({
      baseUrl: 'https://cache-golden.invalid/v1',
      apiKey: 'test-key',
      modelId: 'cache-golden',
      cacheProfile: 'generic',
      fetchImpl: async (_input, init) => {
        if (typeof init?.body !== 'string') {
          throw new Error('最终请求体不是 JSON 文本')
        }
        const parsed: unknown = JSON.parse(init.body)
        if (!isRecord(parsed)) {
          throw new Error('最终请求体不是对象')
        }
        wireBody = parsed

        const encoder = new TextEncoder()
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n')
            )
            controller.enqueue(encoder.encode('data: [DONE]\n\n'))
            controller.close()
          }
        })
        return new Response(stream, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' }
        })
      }
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
      const body = wireBody
      if (!body) throw new Error('模型请求未发生')
      const snapshot = computeWireSnapshot(body, 'generic')

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
