import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { prepareSubagentRuntime } from '../../../src/main/agent/runtime/SubagentRuntimeFactory'
import { extractTextFromContent } from '../../../src/runtime/model/types'
import { SessionStore } from '../../../src/runtime/sessions'
import { DEFAULT_NOVA_SETTINGS } from '../../../src/runtime/settings/novaSettings'
import { resolveSubagentProfileSnapshot } from '../../../src/runtime/subagents'
import { createReadState } from '../../../src/runtime/tools/editTool'
import { MockModelClient } from '../../../src/test-support/builders/MockModelClient'

vi.mock('../../../src/main/agent/runtime/AgentRuntimeFactory', () => ({
  buildModelPoolWithFallbacks: (client: unknown) => client
}))

describe('SubagentRuntimeFactory', () => {
  const roots: string[] = []

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  it('重建 interrupted Child AgentLoop 时回灌已持久化的完整会话历史', () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'nova-subagent-runtime-'))
    roots.push(sessionsDir)
    const workspace = resolve(sessionsDir, 'workspace')
    const store = new SessionStore(sessionsDir)
    const parent = store.create(workspace)
    const skillRoot = resolve(workspace, 'skills', 'inspect')
    const child = store.createChildIfAbsent({
      workspaceRoot: workspace,
      mode: 'plan',
      task: 'inspect',
      subagent: {
        lineage: {
          parentSessionId: parent.id,
          parentRunId: 'run-parent',
          rootRunId: 'run-parent',
          depth: 1,
          spawnKey: 'spawn-key',
          spawnRunId: 'run-child',
          origin: {
            kind: 'skill_fork',
            parentMessageId: 'message-parent',
            skillName: 'inspect'
          }
        },
        profile: resolveSubagentProfileSnapshot({
          name: 'skill:inspect',
          description: 'read only',
          prompt: 'inspect',
          allowedTools: [],
          skillRoots: [skillRoot]
        }, 'skill:inspect')
      }
    }).session
    store.appendMessage(child.id, {
      id: 'child-user',
      role: 'user',
      content: '此前的问题',
      timestamp: 1
    })
    store.appendMessage(child.id, {
      id: 'child-assistant',
      role: 'assistant',
      content: '此前的分析结果',
      timestamp: 2
    })
    const reloaded = store.load(child.id)
    if (!reloaded || reloaded.kind !== 'subagent') throw new Error('expected child')

    const prepared = prepareSubagentRuntime({
      profile: reloaded.subagent.profile,
      task: 'inspect',
      workingDirectory: workspace,
      isolation: 'readonly',
      childSession: reloaded,
      parentRunId: 'run-parent',
      rootRunId: 'run-parent',
      modelClient: new MockModelClient(),
      resolveTool: () => undefined,
      sessionStore: store,
      sessionsDir,
      novaSettings: DEFAULT_NOVA_SETTINGS,
      readState: createReadState(),
      contextWindow: 32_000,
      supportsVision: false
    })

    const history = prepared.agentLoop.getContext().map((message) =>
      extractTextFromContent(message.content)
    )
    expect(history).toContain('此前的问题')
    expect(history).toContain('此前的分析结果')

    // 子代理与主代理共用同一份 Task Policy：装配且无重复
    const systemText = extractTextFromContent(
      prepared.agentLoop.getContext().find((m) => m.role === 'system')!.content
    )
    expect(systemText.match(/=== Task Policy ===/g)).toHaveLength(1)

    expect(prepared.agentLoop.getSkillRoots()).toEqual([skillRoot])
    prepared.agentLoop.dispose()
  })
})
