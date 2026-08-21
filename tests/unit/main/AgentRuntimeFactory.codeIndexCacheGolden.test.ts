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
import { createEmptyCodeContextPack } from '../../../src/runtime/code-graph'
import type {
  CodeContextQueryPort,
  CodeIndexStatus
} from '../../../src/runtime/code-graph'
import type { NovaSettings } from '../../../src/runtime/settings/novaSettings'

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

function createCapturingClient(onBody: (body: Record<string, unknown>) => void) {
  return new OpenAICompatibleModelClient({
    baseUrl: 'https://cache-golden.invalid/v1',
    apiKey: 'test-key',
    modelId: 'cache-golden',
    cacheProfile: 'generic',
    fetchImpl: async (_input, init) => {
      if (typeof init?.body !== 'string') {
        throw new Error('最终请求体不是 JSON 文本')
      }
      const parsed: unknown = JSON.parse(init.body)
      if (!isRecord(parsed)) throw new Error('最终请求体不是对象')
      onBody(parsed)

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
    const modelClient = createCapturingClient(body => {
      wireBody = body
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
        systemContentHash: '3c8b61ec24d23012'
      })
    } finally {
      prepared.agentLoop.dispose()
    }
  })

  it('会话创建后的工具面不随设置或查询端状态改变', async () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'nova-code-graph-session-snapshot-'))
    roots.push(sessionsDir)
    const workspaceRoot = '/nova-code-graph-session-snapshot'
    const store = new SessionStore(sessionsDir)
    const session = store.create(workspaceRoot, 'default', { codeIndexEnabled: true })
    let queryPort: CodeContextQueryPort | null = null

    const run = async (settings: NovaSettings) => {
      let wireBody: Record<string, unknown> | null = null
      const prepared = prepareAgentRuntime({
        session: store.load(session.id) ?? session,
        sessionStore: store,
        sessionId: session.id,
        projectPath: workspaceRoot,
        sessionsDir,
        novaSettings: settings,
        modelClient: createCapturingClient(body => {
          wireBody = body
        }),
        getImageStore: () => new ImageStore(sessionsDir),
        getCodeContextQueryPort: () => queryPort,
        readState: createReadState(),
        pendingAskQuestions: new Map(),
        runCoordinator: createRunCoordinator(join(sessionsDir, 'runs'))
      })
      try {
        await prepared.agentLoop.sendMessage('session snapshot', agentRoute())
        const body = wireBody
        if (!body) throw new Error('模型请求未发生')
        return {
          snapshot: computeWireSnapshot(body, 'generic'),
          definition: prepared.toolRegistry.getToolDefinitions().find(
            definition => definition.name === 'code_context'
          )
        }
      } finally {
        prepared.agentLoop.dispose()
      }
    }

    const enabledSettings = { ...DEFAULT_NOVA_SETTINGS, codeIndexEnabled: true }
    const statuses: readonly CodeIndexStatus[] = [
      'building',
      'ready',
      'degraded',
      'unavailable'
    ]
    const results = []
    for (const status of statuses) {
      queryPort = {
        query: async () => createEmptyCodeContextPack({
          status,
          intent: 'locate',
          summary: `${status} · locate · test`,
          warnings: []
        })
      }
      results.push(await run({
        ...enabledSettings,
        codeIndexEnabled: status === 'building'
      }))
    }

    const first = results[0]
    if (!first) throw new Error('缺少工具面快照')
    expect(first.definition).toBeDefined()
    for (const result of results.slice(1)) {
      expect(result.definition).toEqual(first.definition)
      expect(result.snapshot.toolsHash).toBe(first.snapshot.toolsHash)
      expect(result.snapshot.messages[0]?.content).toBe(first.snapshot.messages[0]?.content)
    }
  })
})
