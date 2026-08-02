import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SubagentProjectionService } from '../../../src/main/agent/subagents'
import { createRunCoordinator } from '../../../src/runtime/run'
import { SessionStore } from '../../../src/runtime/sessions'
import type { SubagentSessionMetadata } from '../../../src/shared/subagents'

describe('SubagentProjectionService', () => {
  let tempRoot: string
  let workspace: string
  let sessionStore: SessionStore
  let coordinator: ReturnType<typeof createRunCoordinator>
  let parentSessionId: string

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'nova-subagent-projection-'))
    workspace = resolve(tempRoot, 'workspace')
    sessionStore = new SessionStore(tempRoot)
    coordinator = createRunCoordinator(join(tempRoot, 'runs'))
    parentSessionId = sessionStore.create(workspace).id
  })

  afterEach(() => rmSync(tempRoot, { recursive: true, force: true }))

  function createChild(toolCallId: string, spawnRunId: string) {
    const metadata: SubagentSessionMetadata = {
      lineage: {
        parentSessionId,
        parentRunId: 'run-parent',
        rootRunId: 'run-parent',
        depth: 1,
        spawnKey: `task_tool:${toolCallId}`,
        spawnRunId,
        origin: {
          kind: 'task_tool',
          parentMessageId: 'msg-parent',
          parentToolCallId: toolCallId
        }
      },
      profile: {
        profileId: 'explore',
        name: 'Explore',
        description: 'inspect',
        systemPrompt: 'secret prompt',
        toolNames: ['read'],
        permissionCeiling: 'read_only',
        maxToolRounds: 20,
        configHash: 'hash'
      }
    }
    return sessionStore.createChildIfAbsent({
      workspaceRoot: workspace,
      mode: 'plan',
      task: 'inspect runtime',
      subagent: metadata
    }).session
  }

  it('从 durable session 与 run 重建父工具投影且不泄露 profile 配置', () => {
    const child = createChild('call-1', 'run-child-1')
    coordinator.startRun({
      kind: 'agent',
      runId: 'run-child-1',
      workspaceId: workspace,
      sessionId: child.id
    })
    coordinator.markRunning('run-child-1', 'msg-final')
    sessionStore.appendMessageFast(child.id, {
      id: 'msg-final',
      role: 'assistant',
      content: 'bounded child summary',
      toolCalls: [{
        id: 'tool-1',
        name: 'read',
        arguments: '{}',
        artifactId: 'artifact-1'
      }],
      timestamp: Date.now()
    })
    coordinator.commitTerminal({ runId: 'run-child-1', status: 'completed' })

    const service = new SubagentProjectionService({ sessionStore, runCoordinator: coordinator })
    const projection = service.getByParentToolCallId(parentSessionId, 'call-1')

    expect(projection).toMatchObject({
      childSessionId: child.id,
      childRunId: 'run-child-1',
      parentSessionId,
      parentToolCallId: 'call-1',
      status: 'completed',
      summary: 'bounded child summary',
      artifactCount: 1,
      profile: {
        profileId: 'explore',
        name: 'Explore',
        permissionCeiling: 'read_only'
      }
    })
    expect(projection?.profile).not.toHaveProperty('systemPrompt')
    expect(projection?.profile).not.toHaveProperty('toolNames')
  })

  it('Child Session 存在但 run 缺失时显式返回 record_missing', () => {
    const child = createChild('call-missing', 'run-missing')
    const service = new SubagentProjectionService({ sessionStore, runCoordinator: coordinator })

    expect(service.listByParentSessionId(parentSessionId)).toEqual([
      expect.objectContaining({
        childSessionId: child.id,
        childRunId: 'run-missing',
        status: 'record_missing'
      })
    ])
  })

  it('启动批量轻投影只扫一次 metadata，不读取终态 transcript', () => {
    const child = createChild('call-light', 'run-light')
    coordinator.startRun({
      kind: 'agent',
      runId: 'run-light',
      workspaceId: workspace,
      sessionId: child.id
    })
    coordinator.markRunning('run-light', 'msg-light')
    coordinator.commitTerminal({ runId: 'run-light', status: 'completed' })
    const listInternal = vi.spyOn(sessionStore, 'listInternal')
    const load = vi.spyOn(sessionStore, 'load')

    const service = new SubagentProjectionService({ sessionStore, runCoordinator: coordinator })
    const projections = service.listLightweightByParentSessionIds([parentSessionId])

    expect(listInternal).toHaveBeenCalledTimes(1)
    expect(load).not.toHaveBeenCalled()
    expect(projections).toEqual([
      expect.objectContaining({
        childSessionId: child.id,
        taskLabel: 'inspect runtime',
        status: 'completed'
      })
    ])
    expect(projections[0]).not.toHaveProperty('summary')
  })

  it('interrupted child 的 pending interaction 仍从父行投影为等待授权', () => {
    const child = createChild('call-waiting', 'run-child-waiting')
    coordinator.startRun({
      kind: 'agent',
      runId: 'run-child-waiting',
      workspaceId: workspace,
      sessionId: child.id
    })
    coordinator.markRunning('run-child-waiting', 'msg-child')
    coordinator.inbox.enqueue({
      runId: 'run-child-waiting',
      sessionId: child.id,
      messageId: 'msg-child',
      type: 'permission',
      interactionId: 'permission-child',
      payload: { requestId: 'permission-child' }
    })
    coordinator.commitTerminal({
      runId: 'run-child-waiting',
      status: 'interrupted',
      reason: 'process_exit'
    })

    const service = new SubagentProjectionService({ sessionStore, runCoordinator: coordinator })
    const projection = service.getByChildSessionId(child.id)

    expect(projection).toEqual(expect.objectContaining({
      status: 'waiting_user',
      latestActivity: '等待你的授权'
    }))
  })
})
