/**
 * 学习会话真实工厂装配的行为验收：
 * - learn：领域角色 + 学习规则，无 Skills/Task Policy/Memory Policy 层，每轮指令来自 preset；
 * - default 对照：同样技能目录下 Skills 层仍在，证明技能排除只作用于 learn。
 */
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { prepareAgentRuntime } from '../../../src/main/agent/runtime/AgentRuntimeFactory'
import { agentRoute } from '../../../src/runtime/agent/turn'
import { OpenAICompatibleModelClient } from '../../../src/runtime/model/OpenAICompatibleModelClient'
import { extractTextFromContent } from '../../../src/runtime/model/types'
import { createRunCoordinator } from '../../../src/runtime/run'
import { SessionStore } from '../../../src/runtime/sessions'
import { resetSessionIndexHostForTests } from '../../../src/runtime/sessions/SessionIndexHost'
import { DEFAULT_NOVA_SETTINGS } from '../../../src/runtime/settings/novaSettings'
import { projectLearningPreset } from '../../../src/runtime/learning/preset/projectLearningPreset'
import { ImageStore } from '../../../src/runtime/storage/ImageStore'
import { createReadState } from '../../../src/runtime/tools/editTool'
import type { SkillManifest } from '../../../src/runtime/skills/types'

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

const DEMO_SKILL: SkillManifest = {
  name: 'demo-skill',
  description: 'demo skill for prompt assembly test',
  userInvocable: true,
  modelInvocable: true,
  body: 'demo skill body',
  source: 'project',
  sourcePath: '/skills/demo-skill/SKILL.md',
  directory: '/skills/demo-skill',
  warnings: [],
  hasSupportingFiles: false,
  enabled: true
}

vi.mock('../../../src/main/services/SkillServiceHost', () => ({
  getSkillService: () => ({
    getWorkspaceRoot: () => '/nova-learn-prompt',
    load: vi.fn(),
    getRegistry: () => ({
      listForContext: () => [DEMO_SKILL],
      get: () => undefined,
      list: () => [DEMO_SKILL]
    })
  }),
  ensureSkillRegistryForWorkspace: () => ({
    listForContext: () => [DEMO_SKILL],
    get: () => undefined,
    list: () => [DEMO_SKILL]
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

function createCapturingClient(onBody: (body: Record<string, unknown>) => void) {
  return new OpenAICompatibleModelClient({
    baseUrl: 'https://learn-prompt.invalid/v1',
    apiKey: 'test-key',
    modelId: 'learn-prompt',
    cacheProfile: 'generic'
  }, {
    fetchImpl: async (_input, init) => {
      if (typeof init?.body !== 'string') {
        throw new Error('最终请求体不是 JSON 文本')
      }
      const parsed: unknown = JSON.parse(init.body)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('最终请求体不是对象')
      }
      onBody(parsed as Record<string, unknown>)

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

describe('AgentRuntimeFactory learn prompt assembly', () => {
  const roots: string[] = []

  afterEach(() => {
    resetSessionIndexHostForTests()
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  async function runOnce(mode: 'learn' | 'default', memoryEnabled: boolean, memoryOptOut = false) {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'nova-learn-prompt-'))
    roots.push(sessionsDir)
    const workspaceRoot = '/nova-learn-prompt'
    const store = new SessionStore(sessionsDir)
    const session = store.create(workspaceRoot, mode)
    session.memoryOptOut = memoryOptOut
    let wireBody: Record<string, unknown> | null = null
    const prepared = prepareAgentRuntime({
      session,
      sessionStore: store,
      sessionId: session.id,
      projectPath: workspaceRoot,
      sessionsDir,
      novaSettings: { ...DEFAULT_NOVA_SETTINGS, memoryEnabled },
      modelClient: createCapturingClient(body => {
        wireBody = body
      }),
      getImageStore: () => new ImageStore(sessionsDir),
      readState: createReadState(),
      pendingAskQuestions: new Map(),
      runCoordinator: createRunCoordinator(join(sessionsDir, 'runs'))
    })
    try {
      await prepared.agentLoop.sendMessage('学习这个项目', agentRoute())
      const body = wireBody
      if (!body) throw new Error('模型请求未发生')
      return structuredClone(body)
    } finally {
      prepared.agentLoop.dispose()
    }
  }

  function systemContent(body: Record<string, unknown>): string {
    const messages = (body.messages ?? []) as Array<{ role: string; content: unknown }>
    const system = messages.find(m => m.role === 'system')
    if (!system || typeof system.content !== 'string') throw new Error('缺少 system message')
    return system.content
  }

  function lastUserText(body: Record<string, unknown>): string {
    const messages = (body.messages ?? []) as Array<{ role: string; content: unknown }>
    const users = messages.filter(m => m.role === 'user')
    const last = users[users.length - 1]
    if (!last) throw new Error('缺少 user message')
    if (typeof last.content !== 'string' && !Array.isArray(last.content)) {
      throw new Error('user message content 类型非法')
    }
    return extractTextFromContent(last.content)
  }

  it('learn 会话系统提示按学习领域装配，不携带开发模式内容', async () => {
    const body = await runOnce('learn', true)
    const system = systemContent(body)

    const roleLayer = system.match(/=== Agent Role ===\n([\s\S]*?)(?=\n\n=== |$)/)
    expect(roleLayer).not.toBeNull()
    const role = roleLayer?.[1] ?? ''
    expect(role).toContain(projectLearningPreset.roleMaterial)
    expect(role).toContain('Workspace root: /nova-learn-prompt')
    expect(role).not.toContain('You are Nova, a collaborative coding agent')
    expect(role).not.toContain('Nova runs in three modes')

    const baseRulesLayer = system.match(/=== Base Rules ===\n([\s\S]*?)(?=\n\n=== |$)/)
    expect(baseRulesLayer).not.toBeNull()
    const baseRules = baseRulesLayer?.[1] ?? ''
    expect(baseRules).toBe(projectLearningPreset.baseRules)
    expect(baseRules).not.toContain('agent_list')
    expect(baseRules).not.toContain('Delegate')
    expect(baseRules).not.toContain('run the relevant tests')

    expect(system).not.toContain('=== Skills ===')
    expect(system).not.toContain('=== Task Policy ===')
    expect(system).not.toContain('=== Memory Policy ===')
    expect(system).toContain('=== Available Tools ===')
  })

  it('learn 会话本轮用户输入尾部等于 preset 每轮指令', async () => {
    const body = await runOnce('learn', false)
    const userText = lastUserText(body)
    const instruction = projectLearningPreset.renderTurnInstruction()
    // 首轮消息带 [Session context] 前缀；用户原文之后紧跟换行分隔的指令，
    // 即尾部恰好等于 preset 指令且只出现一次
    expect(userText.endsWith(`学习这个项目\n\n${instruction}`)).toBe(true)
    expect(userText).not.toContain('像同事当面讲')
    expect(userText).not.toContain('提问只问因果')
  })

  it('default 会话在同一技能目录下仍带 Skills 层', async () => {
    const body = await runOnce('default', false)
    const system = systemContent(body)
    expect(system).toContain('=== Skills ===')
    expect(system).toContain('demo-skill')
  })

  it('opt-out 不注册三个记忆工具，普通会话仍注册', async () => {
    const enabled = await runOnce('default', true)
    const excluded = await runOnce('default', true, true)
    const names = (body: Record<string, unknown>) => JSON.stringify(body.tools)
    for (const name of ['memory_read', 'memory_search', 'memory_manage']) {
      expect(names(enabled)).toContain(`"${name}"`)
      expect(names(excluded)).not.toContain(`"${name}"`)
    }
    expect(systemContent(excluded)).not.toContain('=== Memory Policy ===')
  })
})
