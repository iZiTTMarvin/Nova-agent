import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentLoop } from '../../../../src/runtime/agent'
import { EventBus } from '../../../../src/runtime/agent'
import { AgentTurnExecutor } from '../../../../src/runtime/agent/turn'
import {
  createRunCoordinator,
  RunExecutionRegistry
} from '../../../../src/runtime/run'
import { SessionStore } from '../../../../src/runtime/sessions'
import {
  SubagentExecutionService,
  createSpawnIdentity,
  resolveSubagentProfileSnapshot
} from '../../../../src/runtime/subagents'
import type { SpawnSubagentCommand } from '../../../../src/shared/subagents'

const profile = {
  name: 'explore',
  description: 'read only exploration',
  allowedTools: ['read', 'grep'],
  prompt: 'inspect and summarize',
  maxToolRounds: 20
}

describe('SubagentExecutionService', () => {
  let tempRoot: string
  let workspace: string
  let sessionStore: SessionStore
  let coordinator: ReturnType<typeof createRunCoordinator>
  let parentSessionId: string

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'nova-subagent-service-'))
    workspace = resolve(tempRoot, 'workspace')
    sessionStore = new SessionStore(tempRoot)
    parentSessionId = sessionStore.create(workspace).id
    coordinator = createRunCoordinator(tempRoot)
    coordinator.startRun({
      kind: 'agent',
      runId: 'run-parent',
      workspaceId: workspace,
      sessionId: parentSessionId
    })
    coordinator.markRunning('run-parent', 'msg-parent')
    coordinator.bindExecutionGeneration('run-parent', 41)
  })

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true })
  })

  function command(overrides: Partial<SpawnSubagentCommand> = {}): SpawnSubagentCommand {
    return {
      parentSessionId,
      parentRunId: 'run-parent',
      invocation: {
        kind: 'task_tool',
        parentMessageId: 'msg-parent',
        parentToolCallId: 'call-task'
      },
      profileId: 'explore',
      task: 'inspect runtime',
      workingDirectory: workspace,
      isolation: 'readonly',
      ...overrides
    }
  }

  function invocationRef() {
    return {
      sessionId: parentSessionId,
      runId: 'run-parent',
      messageId: 'msg-parent',
      toolCallId: 'call-task'
    }
  }

  function createService(options: {
    wait?: Promise<void>
    loadProfile?: (profileId: string) => unknown
  } = {}) {
    const prepareTurn = vi.fn((input: any) => {
      const eventBus = new EventBus()
      let fence = (): boolean => false
      const agentLoop = {
        setExecutionIdentity: vi.fn(),
        setExecutionFence: vi.fn((next: () => boolean) => { fence = next }),
        cancel: vi.fn(),
        dispose: vi.fn(),
        sendMessage: vi.fn(async () => {
          expect(fence()).toBe(true)
          eventBus.emit({ type: 'message_start', messageId: 'msg-child-final' })
          if (options.wait) await options.wait
          const appended = sessionStore.appendMessageFast(input.childSession.id, {
            id: 'msg-child-final',
            role: 'assistant',
            content: 'child summary',
            toolCalls: [{
              id: 'read-1',
              name: 'read',
              arguments: '{}',
              artifactId: 'artifact-1'
            }],
            timestamp: Date.now()
          })
          expect(appended.ok).toBe(true)
          eventBus.emit({
            type: 'message_end',
            messageId: 'msg-child-final',
            interrupted: false
          })
          return { status: 'completed' }
        })
      } as unknown as AgentLoop
      return { agentLoop, eventBus }
    })
    const service = new SubagentExecutionService({
      sessionStore,
      runCoordinator: coordinator,
      turnExecutor: new AgentTurnExecutor(
        coordinator,
        new RunExecutionRegistry()
      ),
      loadProfile: options.loadProfile ?? ((profileId) => {
        if (profileId === 'explore') return profile
        if (profileId === 'code') {
          return {
            name: 'code',
            description: 'workspace writer',
            allowedTools: ['read', 'write'],
            prompt: 'implement changes',
            maxToolRounds: 30
          }
        }
        return undefined
      }),
      prepareTurn
    })
    return { service, prepareTurn }
  }

  it('创建 durable Child Session 与预分配 child run，并投影最终结果', async () => {
    const { service, prepareTurn } = createService()
    const spawnCommand = command()
    const expectedIdentity = createSpawnIdentity(spawnCommand)

    const execution = await service.spawn(spawnCommand, {
      invocationRef: invocationRef()
    })

    expect(execution).toEqual({
      childSessionId: expect.stringMatching(/^sess_sub_[0-9a-f]{32}$/),
      childRunId: expectedIdentity.spawnRunId,
      status: 'completed',
      summary: 'child summary',
      artifactIds: ['artifact-1'],
      startedAt: expect.any(Number),
      completedAt: expect.any(Number)
    })
    const child = sessionStore.load(execution.childSessionId)
    expect(child).toEqual(expect.objectContaining({
      kind: 'subagent',
      workspaceRoot: workspace,
      messages: expect.arrayContaining([
        expect.objectContaining({ role: 'user', content: 'inspect runtime' }),
        expect.objectContaining({ role: 'assistant', content: 'child summary' })
      ])
    }))
    if (child?.kind !== 'subagent') throw new Error('expected Child Session')
    expect(child.subagent.lineage).toEqual(expect.objectContaining({
      parentSessionId,
      parentRunId: 'run-parent',
      rootRunId: 'run-parent',
      depth: 1,
      spawnRunId: expectedIdentity.spawnRunId
    }))
    expect(child.subagent.profile.systemPrompt).toBe('inspect and summarize')
    expect(coordinator.getSnapshot(execution.childRunId)?.status).toBe('completed')
    expect(prepareTurn).toHaveBeenCalledTimes(1)
  })

  it('同一 spawnKey 的并发调用连接同一 promise，终态重放不重复模型执行', async () => {
    let release!: () => void
    const wait = new Promise<void>((resolveWait) => { release = resolveWait })
    const { service, prepareTurn } = createService({ wait })
    const spawnCommand = command()
    const context = { invocationRef: invocationRef() }

    const first = service.spawn(spawnCommand, context)
    const second = service.spawn(spawnCommand, context)
    expect(first).toBe(second)
    await expect(service.spawn({ ...spawnCommand, task: 'conflicting task' }, context))
      .rejects.toThrow(/metadata 冲突/)
    release()
    const [firstResult, secondResult] = await Promise.all([first, second])
    expect(firstResult).toEqual(secondResult)
    expect(prepareTurn).toHaveBeenCalledTimes(1)

    const replayed = await service.spawn(spawnCommand, context)
    expect(replayed).toEqual(firstResult)
    expect(prepareTurn).toHaveBeenCalledTimes(1)
    expect(sessionStore.list().filter((item) => item.kind === 'subagent')).toHaveLength(1)
  })

  it('全局 profile 修改后终态重放仍使用 Child Session 中的冻结快照', async () => {
    let currentPrompt = 'original frozen prompt'
    const { service, prepareTurn } = createService({
      loadProfile: () => ({ ...profile, prompt: currentPrompt })
    })
    const spawnCommand = command()
    const context = { invocationRef: invocationRef() }
    const first = await service.spawn(spawnCommand, context)
    currentPrompt = 'new global prompt'

    const replayed = await service.spawn(spawnCommand, context)

    expect(replayed).toEqual(first)
    expect(prepareTurn).toHaveBeenCalledTimes(1)
    const child = sessionStore.load(first.childSessionId)
    expect(child?.kind).toBe('subagent')
    if (child?.kind === 'subagent') {
      expect(child.subagent.profile.systemPrompt).toBe('original frozen prompt')
    }
  })

  it('调用身份、parent identity、profile 与已有 metadata 冲突均 fail closed', async () => {
    const { service } = createService()
    await expect(service.spawn(command(), {
      invocationRef: { ...invocationRef(), toolCallId: 'other-call' }
    })).rejects.toThrow(/调用身份/)
    await expect(service.spawn(command({ parentRunId: 'missing-run' }), {
      invocationRef: { ...invocationRef(), runId: 'missing-run' }
    })).rejects.toThrow(/parent session\/run identity/)
    await expect(service.spawn(command({ profileId: 'unknown' }), {
      invocationRef: invocationRef()
    })).rejects.toThrow(/未知子代理类型/)

    await service.spawn(command(), { invocationRef: invocationRef() })
    await expect(service.spawn(command({ task: 'different task' }), {
      invocationRef: invocationRef()
    })).rejects.toThrow(/冲突/)
  })

  it('父信号已取消时仍持久化 child run cancelled，且不装配 AgentLoop', async () => {
    const controller = new AbortController()
    controller.abort()
    const { service, prepareTurn } = createService()

    const execution = await service.spawn(command(), {
      invocationRef: invocationRef(),
      abortSignal: controller.signal
    })

    expect(execution.status).toBe('cancelled')
    expect(coordinator.getSnapshot(execution.childRunId)?.status).toBe('cancelled')
    expect(prepareTurn).not.toHaveBeenCalled()
    expect(sessionStore.load(execution.childSessionId)?.kind).toBe('subagent')
  })

  it('depth 超限与 read_only 父级权限提升请求均被服务拒绝', async () => {
    const readOnlySnapshot = resolveSubagentProfileSnapshot(profile, 'explore')
    const nestedParent = sessionStore.createChildIfAbsent({
      workspaceRoot: workspace,
      mode: 'plan',
      task: 'nested parent',
      subagent: {
        lineage: {
          parentSessionId,
          parentRunId: 'run-parent',
          rootRunId: 'run-parent',
          depth: 1,
          spawnKey: 'nested-parent-key',
          spawnRunId: 'run-nested-parent',
          origin: {
            kind: 'task_tool',
            parentMessageId: 'msg-parent',
            parentToolCallId: 'call-parent-nested'
          }
        },
        profile: readOnlySnapshot
      }
    }).session
    coordinator.startRun({
      kind: 'agent',
      runId: 'run-nested-parent',
      workspaceId: workspace,
      sessionId: nestedParent.id
    })
    coordinator.markRunning('run-nested-parent', 'msg-nested')
    coordinator.bindExecutionGeneration('run-nested-parent', 51)

    const { service } = createService()
    const nestedCommand: SpawnSubagentCommand = {
      parentSessionId: nestedParent.id,
      parentRunId: 'run-nested-parent',
      invocation: {
        kind: 'task_tool',
        parentMessageId: 'msg-nested',
        parentToolCallId: 'call-nested'
      },
      profileId: 'code',
      task: 'attempt write',
      workingDirectory: workspace,
      isolation: 'shared'
    }
    const nestedRef = {
      sessionId: nestedParent.id,
      runId: 'run-nested-parent',
      messageId: 'msg-nested',
      toolCallId: 'call-nested'
    }
    await expect(service.spawn(nestedCommand, {
      invocationRef: nestedRef
    })).rejects.toThrow(/read_only/)

    const codeSnapshot = resolveSubagentProfileSnapshot({
      name: 'code',
      description: 'workspace writer',
      allowedTools: ['read', 'write'],
      prompt: 'implement changes',
      maxToolRounds: 30
    }, 'code')
    const depthTwo = sessionStore.createChildIfAbsent({
      workspaceRoot: workspace,
      mode: 'default',
      task: 'depth two parent',
      subagent: {
        lineage: {
          ...nestedParent.subagent.lineage,
          depth: 2,
          spawnKey: 'depth-two-parent-key',
          spawnRunId: 'run-depth-two-parent'
        },
        profile: codeSnapshot
      }
    }).session
    coordinator.startRun({
      kind: 'agent',
      runId: 'run-depth-two-parent',
      workspaceId: workspace,
      sessionId: depthTwo.id
    })
    coordinator.markRunning('run-depth-two-parent', 'msg-depth-two')
    coordinator.bindExecutionGeneration('run-depth-two-parent', 61)
    await expect(service.spawn({
      ...nestedCommand,
      parentSessionId: depthTwo.id,
      parentRunId: 'run-depth-two-parent',
      profileId: 'explore',
      invocation: {
        kind: 'task_tool',
        parentMessageId: 'msg-depth-two',
        parentToolCallId: 'call-depth-three'
      }
    }, {
      invocationRef: {
        sessionId: depthTwo.id,
        runId: 'run-depth-two-parent',
        messageId: 'msg-depth-two',
        toolCallId: 'call-depth-three'
      }
    })).rejects.toThrow(/超过上限/)
  })
})
